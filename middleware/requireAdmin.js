const { requireRole } = require('./authJwt');

// Requiere rol admin O superadmin (superadmin es superconjunto de admin). El rol es
// el VIGENTE en la base, no el que quedó grabado en el token.
module.exports = requireRole(['admin', 'superadmin'], 'Se requiere rol administrador');
