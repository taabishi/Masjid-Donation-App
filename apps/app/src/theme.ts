export const colors = {
  primary: '#0f6b4f',
  primaryDark: '#0a4d38',
  primarySoft: '#e3f1ec',
  bg: '#f6f7f5',
  card: '#ffffff',
  text: '#16231e',
  muted: '#667570',
  border: '#dde4e0',
  danger: '#b3261e',
  gold: '#b8892b',
};

export const cents = (c: number) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;
