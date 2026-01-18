
export enum Role {
  USER = 'user',
  MODEL = 'model',
  SYSTEM = 'system'
}

export type AppMode = 'roast' | 'girlfriend' | 'boyfriend' | 'mentor' | 'scientist' | 'coder';

export interface Message {
  id: string;
  role: Role;
  text: string;
  timestamp: number;
  attachments?: string[]; // Base64 images
  isImageGeneration?: boolean;
  groundingMetadata?: any;
  isFavorite?: boolean; // New: bookmarking support
}

export interface ChatThread {
  id: string;
  title: string;
  messages: Message[];
  mode: AppMode;
  lastUpdate: number;
}

export interface PersonaConfig {
  mode: AppMode;
  sarcasm: number;   
  edge: number;      
  language: string;  
  fastReply: boolean;
  useSearch: boolean;
  useMaps: boolean;
}
