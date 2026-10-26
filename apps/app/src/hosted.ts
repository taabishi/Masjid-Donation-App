import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

/** Where Stripe's hosted page should send the user back to: the site on web, a deep link on native. */
export function returnUrl(path: string) {
  return Platform.OS === 'web' ? window.location.origin + path : Linking.createURL(path);
}

/**
 * Open a provider-hosted page (Stripe Checkout / Connect onboarding).
 * Web navigates away and comes back via the return URL; native shows an in-app browser sheet and resolves when it closes.
 */
export async function openHosted(url: string) {
  if (Platform.OS === 'web') {
    window.location.assign(url);
    return;
  }
  await WebBrowser.openBrowserAsync(url);
}
