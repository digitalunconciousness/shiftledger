import React, { useEffect } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import useAuthStore from './app/store/authStore';

import LoginScreen from './app/screens/LoginScreen';
import SignupScreen from './app/screens/SignupScreen';
import HomeScreen from './app/screens/HomeScreen';
import AddShiftScreen from './app/screens/AddShiftScreen';
import EditShiftScreen from './app/screens/EditShiftScreen';

const Stack = createNativeStackNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: '#0d0d0d' },
  headerTintColor: '#f5a623',
  headerTitleStyle: { fontWeight: '700', color: '#f0f0f0' },
  headerBackTitleVisible: false,
  contentStyle: { backgroundColor: '#0d0d0d' },
};

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ ...screenOptions, headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Signup" component={SignupScreen} />
    </Stack.Navigator>
  );
}

function AppStack() {
  return (
    <Stack.Navigator screenOptions={screenOptions}>
      <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
      <Stack.Screen name="AddShift" component={AddShiftScreen} options={{ title: 'Add Shift' }} />
      <Stack.Screen name="EditShift" component={EditShiftScreen} options={{ title: 'Edit Shift' }} />
    </Stack.Navigator>
  );
}

export default function App() {
  const { token, isLoading, hydrate } = useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (isLoading) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#f5a623" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.flex}>
      <NavigationContainer>
        {token ? <AppStack /> : <AuthStack />}
      </NavigationContainer>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  splash: {
    flex: 1,
    backgroundColor: '#0d0d0d',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
