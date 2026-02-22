export class app_error extends Error {
  status_code: number;

  constructor(message: string, status_code = 400) {
    super(message);
    this.status_code = status_code;
  }
}
