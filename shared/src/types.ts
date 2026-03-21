export type Game = {
  id: string;
  joinCode: string;
  status: 'lobby' | 'in_progress' | 'finished';
};
