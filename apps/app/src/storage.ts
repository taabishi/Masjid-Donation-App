import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// SecureStore has no web implementation, so fall back to localStorage there.
export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}

export async function setItem(key: string, value: string) {
  if (Platform.OS === 'web') return void localStorage.setItem(key, value);
  await SecureStore.setItemAsync(key, value);
}

export async function removeItem(key: string) {
  if (Platform.OS === 'web') return void localStorage.removeItem(key);
  await SecureStore.deleteItemAsync(key);
}
