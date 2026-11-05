export interface User {
  id: string;
  username: string;
  salt: string;
  hash: string;
  createdAt: string;
}

export interface Session {
  userId: string;
  expires: number;
}
