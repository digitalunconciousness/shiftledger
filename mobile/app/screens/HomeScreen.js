import React from 'react';
import { View, Text, FlatList, Button, StyleSheet } from 'react-native';

const shiftsData = [
  { id: '1', name: 'Shift 1', time: '09:00 - 17:00' },
  { id: '2', name: 'Shift 2', time: '17:00 - 01:00' },
];

const HomeScreen = () => {
  const editShift = (id) => {
    // Edit shift logic here
    console.log('Edit shift:', id);
  };

  const deleteShift = (id) => {
    // Delete shift logic here
    console.log('Delete shift:', id);
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={shiftsData}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.shiftContainer}>
            <Text>{item.name} ({item.time})</Text>
            <Button title='Edit' onPress={() => editShift(item.id)} />
            <Button title='Delete' onPress={() => deleteShift(item.id)} />
          </View>
        )}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  shiftContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
  },
});

export default HomeScreen;
