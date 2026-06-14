/**
 * Validation error for invalid input or configuration.
 */
const AppError = require('./AppError');

class ValidationError extends AppError {
  constructor(message, field = null) {
    super(message, 'VALIDATION_ERROR', 400);
    this.field = field;
  }
}

module.exports = ValidationError;
