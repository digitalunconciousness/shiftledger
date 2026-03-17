import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { ShiftsService } from '../services/api';
import useShiftStore from '../store/shiftStore';

export default function AddShiftScreen({ navigation }) {
    const [date, setDate] = useState('');
    const [startTime, setStartTime] = useState('');
    const [endTime, setEndTime] = useState('');
    const [jobId, setJobId] = useState('');
    const [notes, setNotes] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const { addShift } = useShiftStore();

    const handleAddShift = async () => {
        if (!date || !startTime || !endTime || !jobId) {
            setError('Please fill in all required fields');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const shiftData = { date, startTime, endTime, jobId, notes };
            const { data } = await ShiftsService.createShift(shiftData);
            addShift(data);
            navigation.goBack();
        } catch (err) {
            setError(err.response?.data?.message || 'Failed to add shift');
        } finally {
            setLoading(false);
        }
    };

    return (
        <ScrollView style={styles.container}>
            <Text style={styles.title}>Add New Shift</Text>
            <TextInput style={styles.input} placeholder="Date (YYYY-MM-DD)" value={date} onChangeText={setDate} editable={!loading} />
            <TextInput style={styles.input} placeholder="Start Time (HH:MM)" value={startTime} onChangeText={setStartTime} editable={!loading} />
            <TextInput style={styles.input} placeholder="End Time (HH:MM)" value={endTime} onChangeText={setEndTime} editable={!loading} />
            <TextInput style={styles.input} placeholder="Job ID" value={jobId} onChangeText={setJobId} editable={!loading} />
            <TextInput style={[styles.input, styles.notesInput]} placeholder="Notes (optional)" value={notes} onChangeText={setNotes} multiline editable={!loading} />
            {error && <Text style={styles.errorText}>{error}</Text>}
            <TouchableOpacity style={[styles.button, loading && styles.buttonDisabled]} onPress={handleAddShift} disabled={loading} >
                {loading ? (
                    <ActivityIndicator color="#fff" />
                ) : (
                    <Text style={styles.buttonText}>Add Shift</Text>
                )}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => navigation.goBack()}>
                <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, paddingHorizontal: 20, paddingVertical: 20, backgroundColor: '#f5f5f5' },
    title: { fontSize: 26, fontWeight: 'bold', marginBottom: 20, color: '#333' },
    input: { borderWidth: 1, borderColor: '#ddd', padding: 12, marginBottom: 15, borderRadius: 8, backgroundColor: '#fff', fontSize: 14 },
    notesInput: { minHeight: 100, textAlignVertical: 'top' },
    button: { backgroundColor: '#007AFF', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 10 },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
    errorText: { color: '#d32f2f', marginBottom: 10, textAlign: 'center' },
    cancelText: { color: '#007AFF', textAlign: 'center', marginTop: 15, fontSize: 14 }
});