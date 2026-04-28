const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/locales', require('./routes/locales'));
app.use('/api/rubros', require('./routes/rubros'));
app.use('/api/campos', require('./routes/campos'));
app.use('/api/categorias', require('./routes/categorias'));
app.use('/api/subrubros', require('./routes/subrubros'));
app.use('/api/movimientos', require('./routes/movimientos'));

const PORT = 3001;
app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`));
