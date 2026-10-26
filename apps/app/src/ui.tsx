import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { colors } from './theme';

export function Screen({ children, scroll = true }: { children: React.ReactNode; scroll?: boolean }) {
  const inner = <View style={s.screenInner}>{children}</View>;
  return scroll ? (
    <ScrollView style={s.screen} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">{inner}</ScrollView>
  ) : (
    <View style={s.screen}>{inner}</View>
  );
}

export const H1 = ({ children }: { children: React.ReactNode }) => <Text style={s.h1}>{children}</Text>;
export const H2 = ({ children }: { children: React.ReactNode }) => <Text style={s.h2}>{children}</Text>;
export const Muted = ({ children, style }: { children: React.ReactNode; style?: object }) => <Text style={[s.muted, style]}>{children}</Text>;
export const ErrorText = ({ children }: { children?: string | null }) => (children ? <Text style={s.error}>{children}</Text> : null);

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({
  title, onPress, variant = 'primary', busy, disabled, style,
}: {
  title: string; onPress: () => void; variant?: 'primary' | 'outline' | 'danger'; busy?: boolean; disabled?: boolean; style?: ViewStyle;
}) {
  const off = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={off ? undefined : onPress}
      style={[s.btn, variant === 'outline' && s.btnOutline, variant === 'danger' && s.btnDanger, off && { opacity: 0.5 }, style]}
    >
      {busy ? <ActivityIndicator color={variant === 'primary' ? '#fff' : colors.primary} /> : (
        <Text style={[s.btnText, variant === 'outline' && { color: colors.primary }, variant === 'danger' && { color: '#fff' }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} style={s.input} {...props} />
    </View>
  );
}

export function Chip({ title, selected, onPress }: { title: string; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, selected && s.chipSelected]}>
      <Text style={[s.chipText, selected && { color: '#fff' }]}>{title}</Text>
    </Pressable>
  );
}

export const Loading = () => <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />;

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // keeps content readable on wide web screens
  screenInner: { padding: 16, width: '100%', maxWidth: 640, alignSelf: 'center', flexGrow: 1 },
  h1: { fontSize: 26, fontWeight: '700', color: colors.text, marginBottom: 4 },
  h2: { fontSize: 18, fontWeight: '600', color: colors.text, marginTop: 16, marginBottom: 8 },
  muted: { color: colors.muted, fontSize: 14 },
  error: { color: colors.danger, marginVertical: 8 },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.border },
  btn: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  btnOutline: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.primary },
  btnDanger: { backgroundColor: colors.danger },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted, marginBottom: 4 },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, fontSize: 16, color: colors.text },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, borderColor: colors.primary, marginRight: 8, marginBottom: 8 },
  chipSelected: { backgroundColor: colors.primary },
  chipText: { color: colors.primary, fontWeight: '600' },
});
