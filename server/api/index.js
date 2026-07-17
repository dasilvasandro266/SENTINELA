const express = require('express');
const authRoutes = require('./auth');
const userRoutes = require('./user');

const router = express.Router();

router.use('/', authRoutes);
router.use('/user', userRoutes);

module.exports = router;
