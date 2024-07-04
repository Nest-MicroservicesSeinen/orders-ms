import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus, PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { ChangeOrderStatusDto, OrderPaginationDto } from './dto';
import { PaginationDto } from '../common/index'
import { catchError, firstValueFrom } from 'rxjs';
import { NATS_SERVICE } from 'src/config';

@Injectable()
export class OrdersService  extends PrismaClient implements OnModuleInit{

  private readonly logger = new Logger('OrdersService')
  constructor(
    @Inject(NATS_SERVICE) private readonly productsClient: ClientProxy
  ){
    super();
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database Connected');
  }

  async create(createOrderDto: CreateOrderDto) {

    //TodOs transformo mi objeto en un arreglo de ids
    const productsId = createOrderDto.items.map(product => product.productId);

    //TodOs Verifica si existen los productos
    const products = await firstValueFrom(this.productsClient.send({ cmd: 'validate_products'},  productsId )
      .pipe(
        catchError( error => { throw new RpcException(error) } )
      )
    )

    //TodOs Calcular valores
    const totalAmount = createOrderDto.items.reduce( (acc, orderItem) => {
      
      const price = products.find( 
        (product) => product.id === orderItem.productId 
      ).price;

      return acc + (price * orderItem.quantity);

    }, 0);

    const totalItems = createOrderDto.items.reduce( (acc, orderItem) => {
      return acc + orderItem.quantity;
    }, 0);

    //? transaccion de bd 
    const order = await this.order.create({
      data: {
        totalAmount,
        totalItems,
        OrderItem: {
          createMany: {
            data: createOrderDto.items.map( (orderItem) => ({
              price: products.find( 
                product => product.id ===  orderItem.productId 
              ).price,
              productId: orderItem.productId,
              quantity: orderItem.quantity
            }))
          }
        }
      },
      include: {
        OrderItem: {
          select: {
            price: true,
            quantity: true,
            productId: true
          }
        }
      }
    })
    
    return {
      ...order,
      OrderItem: order.OrderItem.map( (orderItem) => ({
        ...orderItem,
        name: products.find( product  => product.id === orderItem.productId).name
      }) )
    }
  }

  async findAll(orderPaginationDto: OrderPaginationDto) {

    const totalPages = await this.order.count({
      where: {
        status: orderPaginationDto.status
      }
    })

    const currentPage = orderPaginationDto.page;
    const perPage = orderPaginationDto.limit;

    

    return {
      data: await this.order.findMany({
        skip: ( currentPage - 1 ) * perPage,
        take: perPage,
        where: {
          status: orderPaginationDto.status
        }
      }),
      meta: { 
        total: totalPages,
        page: currentPage,
        lastPage: Math.ceil( totalPages / perPage )
      }
    }
  }
  
  async findOne(id: string) {

    const order = await this.order.findFirst({
      where: { id },
      include: {
        OrderItem: {
          select: {
            price: true,
            quantity: true,
            productId: true
          }
        }
      }
    });

    if( !order  ){
      throw new RpcException({
        status: HttpStatus.NOT_FOUND,
        message: `Order with id ${ id } not found`
      });
    }

    const productsId = order.OrderItem.map(orderItem => orderItem.productId);

    const products = await firstValueFrom(this.productsClient.send({ cmd: 'validate_products'},  productsId )
      .pipe(
        catchError( error => { throw new RpcException(error) } )
      )
    );

    return {...order, OrderItem: order.OrderItem.map( (orderItem) => ({
        ...orderItem,
        name: products.find( product  => product.id === orderItem.productId).name
      })) 
    }
  }

  async changeStatus(changeOrderStatusDto: ChangeOrderStatusDto){
    const { id, status  } = changeOrderStatusDto;
  
    const order  = await this.findOne(id);
    
    if (  order.status === status){
      return order;
    }

    return this.order.update({
      where: { id },
      data: { status  }
    })

  
  }

}
