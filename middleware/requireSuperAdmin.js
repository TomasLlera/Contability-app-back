const { requireRole } = require('./authJwt');

// Requiere rol superadmin: control total del sistema, incluida la gestión de usuarios.
// El rol es el VIGENTE en la base, no el que quedó grabado en el token.
module.exports = requireRole(['superadmin'], 'Se requiere rol Super Administrador');
