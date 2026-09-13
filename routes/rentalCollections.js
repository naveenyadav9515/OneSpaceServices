const express = require('express');
const router = express.Router();
const rentalCollectionController = require('../controllers/rentalCollectionController');
const { protect } = require('../middleware/auth');

// All rental collection routes require authentication
router.use(protect);

router.route('/tenants')
  .get(rentalCollectionController.getTenants)
  .post(rentalCollectionController.addTenant);

router.patch('/tenants/:name/toggle', rentalCollectionController.toggleTenant);
router.delete('/tenants/:name', rentalCollectionController.deleteTenant);

router.route('/')
  .get(rentalCollectionController.getRentalCollections)
  .post(rentalCollectionController.createRentalCollection);

router.delete('/:id', rentalCollectionController.deleteRentalCollection);

module.exports = router;
