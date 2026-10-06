export class NotImplementedError extends Error {
  constructor(moduleName) {
    super(`Module à implémenter : ${moduleName}`);
    this.name = 'NotImplementedError';
    this.code = 'NOT_IMPLEMENTED';
  }
}
