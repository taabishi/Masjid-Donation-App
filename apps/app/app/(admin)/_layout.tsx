import { Tabs } from 'expo-router';
import { colors } from '../../src/theme';

export default function AdminLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary }}>
      <Tabs.Screen name="index" options={{ title: 'Dashboard', tabBarLabel: 'Dashboard' }} />
      <Tabs.Screen name="verification" options={{ title: 'Verification', tabBarLabel: 'Verification' }} />
      <Tabs.Screen name="mosque" options={{ title: 'Mosque Page', tabBarLabel: 'Mosque Page' }} />
    </Tabs>
  );
}
