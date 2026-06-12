# AI Financial Budgeting System - Backend

Backend API for the AI Financial Budgeting System built with Node.js, Express.js, and MongoDB.

## 🚀 Getting Started

### Prerequisites

- Node.js (v16 or higher)
- MongoDB (local or MongoDB Atlas)
- npm or yarn

### Installation

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` with your configuration.

3. **Start the development server**
   ```bash
   npm run dev
   ```

4. **Start the production server**
   ```bash
   npm start
   ```

## 📁 Project Structure

```
src/
├── config/          # Configuration files
│   ├── database.js  # MongoDB connection
│   └── swagger.js   # Swagger documentation setup
├── controllers/     # Request handlers
├── models/          # Database models
├── routes/          # API routes
├── middleware/     # Custom middleware
├── services/        # Business logic
├── utils/           # Helper functions
└── server.js        # Application entry point
```

## 🔧 Environment Variables

Copy `.env.example` to `.env` and set the required values.

For the internet-aware assistant, the new required search keys are:

- `TAVILY_API_KEY` for general live web search
- `SERPAPI_API_KEY` for shopping and price lookup

The assistant still requires the existing Azure OpenAI variables:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT_NAME`
- `AZURE_OPENAI_MODEL_NAME`
- `AZURE_OPENAI_API_VERSION`
- `AZURE_OPENAI_MAX_TOKENS`

## 📚 API Documentation

Once the server is running, access the Swagger API documentation at:
```
http://localhost:3000/api-docs
```

## 🛠️ Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon

## 📝 License

ISC

