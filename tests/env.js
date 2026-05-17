// Carga env vars antes de cualquier require de la app.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-of-at-least-32-characters-long';
process.env.MONGODB_URI = 'mongodb://placeholder/test'; // será reemplazado por mongodb-memory-server
process.env.LOG_LEVEL = 'silent';
