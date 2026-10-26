import { Tabs } from 'expo-router';
import { colors } from '../../src/theme';

export default function DonorLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary, headerTitleStyle: { color: colors.text } }}>
      <Tabs.Screen name="index" options={{ title: 'My Mosques', tabBarLabel: 'Give' }} />
      <Tabs.Screen name="discover" options={{ title: 'Find a Mosque', tabBarLabel: 'Discover' }} />
      <Tabs.Screen name="payment" options={{ title: 'Payment Methods', tabBarLabel: 'Payment' }} />
      <Tabs.Screen name="recurring" options={{ title: 'Recurring', tabBarLabel: 'Recurring' }} />
      <Tabs.Screen name="history" options={{ title: 'History & Account', tabBarLabel: 'History' }} />
    </Tabs>
  );
}
