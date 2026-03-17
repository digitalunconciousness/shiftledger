import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TextInput,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import useShiftStore from '../store/shiftStore';
import useAuthStore from '../store/authStore';

function ShiftCard({ shift, onEdit, onDelete }) {
  const earned = `$${shift.grand_total.toFixed(2)}`;
  const wages = `$${shift.wage_total.toFixed(2)}`;
  const tips = `$${shift.total_tips.toFixed(2)}`;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardDate}>{shift.date}</Text>
        {shift.job_name ? (
          <View style={[styles.jobBadge, { backgroundColor: shift.job_color || '#f5a623' }]}>
            <Text style={styles.jobBadgeText}>{shift.job_name}</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.cardTotal}>{earned}</Text>
      <Text style={styles.cardDetail}>
        {shift.hours_worked}h @ ${shift.hourly_rate}/hr · wages {wages} · tips {tips}
      </Text>
      {shift.notes ? <Text style={styles.cardNotes}>{shift.notes}</Text> : null}
      <View style={styles.cardActions}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => onEdit(shift)}>
          <Text style={styles.actionBtnText}>Edit</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, styles.deleteBtn]} onPress={() => onDelete(shift)}>
          <Text style={[styles.actionBtnText, styles.deleteBtnText]}>Delete</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function HomeScreen({ navigation }) {
  const { shifts, isLoading, error, fetchShifts, deleteShift, filterShifts } = useShiftStore();
  const { user, logout } = useAuthStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const loadShifts = useCallback(async () => {
    await fetchShifts();
  }, [fetchShifts]);

  // Reload shifts whenever the screen comes into focus
  useFocusEffect(
    useCallback(() => {
      loadShifts();
    }, [loadShifts]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadShifts();
    setRefreshing(false);
  };

  const handleDelete = (shift) => {
    Alert.alert(
      'Delete Shift',
      `Delete the shift on ${shift.date}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const result = await deleteShift(shift.id);
            if (!result.success) {
              Alert.alert('Error', result.error);
            }
          },
        },
      ],
    );
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: logout },
    ]);
  };

  const filtered = searchQuery.trim() ? filterShifts(searchQuery.trim()) : shifts;

  const totalEarned = filtered.reduce((sum, s) => sum + s.grand_total, 0);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>ShiftLedger</Text>
          <Text style={styles.headerSub}>
            {user?.display_name || user?.username || 'My Shifts'}
          </Text>
        </View>
        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>
      </View>

      {/* Summary */}
      {filtered.length > 0 && (
        <View style={styles.summary}>
          <Text style={styles.summaryLabel}>{filtered.length} shift{filtered.length !== 1 ? 's' : ''}</Text>
          <Text style={styles.summaryTotal}>${totalEarned.toFixed(2)} earned</Text>
        </View>
      )}

      {/* Search */}
      <TextInput
        style={styles.search}
        placeholder="Search by date, job, or notes…"
        placeholderTextColor="#555"
        value={searchQuery}
        onChangeText={setSearchQuery}
        clearButtonMode="while-editing"
      />

      {/* Error */}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {/* List */}
      {isLoading && !refreshing ? (
        <ActivityIndicator style={styles.loader} color="#f5a623" size="large" />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <ShiftCard
              shift={item}
              onEdit={(shift) => navigation.navigate('EditShift', { shift })}
              onDelete={handleDelete}
            />
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              {searchQuery ? 'No shifts match your search.' : 'No shifts yet. Tap + to add one.'}
            </Text>
          }
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f5a623" />}
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('AddShift')}
        accessibilityLabel="Add shift"
      >
        <Text style={styles.fabIcon}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d0d',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f5a623',
    letterSpacing: 0.5,
  },
  headerSub: {
    fontSize: 12,
    color: '#777',
    marginTop: 2,
  },
  logoutBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
  },
  logoutText: {
    color: '#aaa',
    fontSize: 13,
  },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#141414',
  },
  summaryLabel: {
    color: '#888',
    fontSize: 13,
  },
  summaryTotal: {
    color: '#f5a623',
    fontSize: 16,
    fontWeight: '700',
  },
  search: {
    margin: 16,
    marginBottom: 8,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: '#f0f0f0',
  },
  errorText: {
    color: '#e05252',
    textAlign: 'center',
    paddingHorizontal: 20,
    marginBottom: 8,
    fontSize: 13,
  },
  loader: {
    marginTop: 60,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 100,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#252525',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardDate: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: '500',
  },
  jobBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  jobBadgeText: {
    color: '#0d0d0d',
    fontSize: 11,
    fontWeight: '700',
  },
  cardTotal: {
    color: '#f5a623',
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 4,
  },
  cardDetail: {
    color: '#888',
    fontSize: 12,
    marginBottom: 4,
  },
  cardNotes: {
    color: '#666',
    fontSize: 12,
    fontStyle: 'italic',
    marginBottom: 8,
  },
  cardActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 8,
  },
  actionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#252525',
    borderWidth: 1,
    borderColor: '#333',
  },
  actionBtnText: {
    color: '#ccc',
    fontSize: 13,
    fontWeight: '500',
  },
  deleteBtn: {
    backgroundColor: '#2a1a1a',
    borderColor: '#4a2020',
  },
  deleteBtnText: {
    color: '#e05252',
  },
  emptyText: {
    color: '#555',
    textAlign: 'center',
    marginTop: 60,
    fontSize: 15,
    lineHeight: 22,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 30,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#f5a623',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#f5a623',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
  },
  fabIcon: {
    color: '#0d0d0d',
    fontSize: 30,
    fontWeight: '300',
    lineHeight: 34,
  },
});
