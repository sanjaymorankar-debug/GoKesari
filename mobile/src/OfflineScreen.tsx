import { Pressable, StyleSheet, Text, View } from "react-native";

import { COLORS } from "./config";

/** Shown over the WebView when a page cannot load: no connection, the site is down. */
export function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.container} accessibilityRole="alert">
      <Text style={styles.title}>{"Can't reach GoKesari"}</Text>
      <Text style={styles.message}>Check your internet connection and try again.</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: COLORS.cream,
  },
  title: { fontSize: 20, fontWeight: "600", color: COLORS.ink, marginBottom: 8, textAlign: "center" },
  message: { fontSize: 15, color: COLORS.muted, marginBottom: 24, textAlign: "center" },
  button: { backgroundColor: COLORS.kesari, borderRadius: 8, paddingHorizontal: 24, paddingVertical: 12 },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
});
