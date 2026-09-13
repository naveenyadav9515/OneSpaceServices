const express = require('express');
const router = express.Router();
const rentalCollectionController = require('../controllers/rentalCollectionController');
const { protect } = require('../middleware/auth');

// All rental collection routes require authentication
router.use(protect);

router.get('/tenants', rentalCollectionController.getTenants);

router.route('/')
  .get(rentalCollectionController.getRentalCollections)
  .post(rentalCollectionController.createRentalCollection);

router.delete('/:id', rentalCollectionController.deleteRentalCollection);

module.exports = router;
