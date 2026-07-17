import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { isAllowedFrontendOrigin } from './common/allowed-origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const http = app.getHttpAdapter().getInstance();
  http.set('trust proxy', 1);
  app.setGlobalPrefix('api');

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) return callback(null, true);
      return callback(null, isAllowedFrontendOrigin(origin));
    },
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  const port = process.env.PORT || 4000;
  await app.listen(port);
  console.log(`PRA Connector API → http://localhost:${port}/api`);
  console.log(
    `QBO config → env=${process.env.QBO_ENVIRONMENT || 'sandbox'} redirect=${process.env.QBO_REDIRECT_URI || '(unset)'} frontend=${process.env.FRONTEND_URL || '(unset)'}`,
  );
}
bootstrap();
