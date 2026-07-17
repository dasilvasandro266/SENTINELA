const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.warn('⚠️ JWT_SECRET não definido. Configure a variável de ambiente para produção.');
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido ou expirado' });
        }
        req.user = user;
        next();
    });
}

function authorizeAdmin(req, res, next) {
    const isAdmin = req.user?.isAdmin === true || req.user?.isAdmin === 1 || req.user?.isAdmin === "1";
    if (!isAdmin) {
        return res.status(403).json({ error: "Apenas administradores podem executar esta ação" });
    }
    next();
}

module.exports = { authenticateToken, authorizeAdmin };
