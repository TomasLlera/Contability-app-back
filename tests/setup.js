const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongo;

// Llamado desde cada test file con `setupTestDb()` antes de los describe.
function setupTestDb() {
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  });

  afterEach(async () => {
    for (const c of Object.values(mongoose.connection.collections)) {
      await c.deleteMany({});
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });
}

module.exports = { setupTestDb };
