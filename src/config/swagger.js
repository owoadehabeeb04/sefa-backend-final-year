const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'AI Financial Budgeting System (Final Year Project) API',
      version: '1.0.0',
      description: 'RESTful API for AI Financial Budgeting System',
      contact: {
        name: 'API Support',
      },
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3000}`,
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  },
  apis: ['./src/controllers/**/*.js', './src/routes/**/*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

const swaggerSetup = (app) => {
  if (process.env.SWAGGER_ENABLED === 'true') {
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
    console.log(`Swagger documentation available at http://localhost:${process.env.PORT || 3000}/api-docs`);
  }
};

module.exports = { swaggerSetup, swaggerSpec };

