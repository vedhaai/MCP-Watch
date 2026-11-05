// An error with the HTTP status the API answers with; the message is shown to the user.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
