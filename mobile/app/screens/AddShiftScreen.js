import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import useShiftStore from '../store/shiftStore';

const TIP_MODES = [
  { label: 'Total Tips', value: 'total' },
  { label: 'Tips / Hour', value: 'per_hour' },
];

export default function AddShiftScreen({ navigation }) {
  const { addShift, jobs, fetchJobs } = useShiftStore();

  const today = new Date().toISOString().split('T')[0];

  const [date, setDate] = useState(today);
  const [hourlyRate, setHourlyRate] = useState('');
  const [hoursWorked, setHoursWorked] = useState('');
  const [tipMode, setTipMode] = useState('total');
  const [tipInput, setTipInput] = useState('0');
  const [notes, setNotes] = useState('');
  const [jobId, setJobId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  // Live totals preview
  const rate = parseFloat(hourlyRate) || 0;
  const hours = parseFloat(hoursWorked) || 0;
  const tip = parseFloat(tipInput) || 0;
  const totalTips = tipMode === 'per_hour' ? tip * hours : tip;
  const wageTotal = rate * hours;
  const grandTotal = wageTotal + totalTips;

  const validate = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Date must be YYYY-MM-DD';
    if (isNaN(rate) || rate < 0) return 'Enter a valid hourly rate';
    if (isNaN(hours) || hours < 0) return 'Enter valid hours worked';
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { Alert.alert('Validation Error', err); return; }

    setSubmitting(true);
    const result = await addShift({
      date,
      hourly_rate: rate,
      hours_worked: hours,
      tip_mode: tipMode,
      tip_input: tip,
      notes: notes.trim(),
      job_id: jobId,
    });
    setSubmitting(false);

    if (result.success) {
      navigation.goBack();
    } else {
      Alert.alert('Error', result.error);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionTitle}>Shift Details</Text>

        <Text style={styles.label}>Date</Text>
        <TextInput
          style={styles.input}
          placeholder="YYYY-MM-DD"
          placeholderTextColor="#555"
          value={date}
          onChangeText={setDate}
          keyboardType="numbers-and-punctuation"
        />

        <Text style={styles.label}>Hourly Rate ($)</Text>
        <TextInput
          style={styles.input}
          placeholder="0.00"
          placeholderTextColor="#555"
          keyboardType="decimal-pad"
          value={hourlyRate}
          onChangeText={setHourlyRate}
        />

        <Text style={styles.label}>Hours Worked</Text>
        <TextInput
          style={styles.input}
          placeholder="0.0"
          placeholderTextColor="#555"
          keyboardType="decimal-pad"
          value={hoursWorked}
          onChangeText={setHoursWorked}
        />

        <Text style={styles.label}>Tip Mode</Text>
        <View style={styles.segmented}>
          {TIP_MODES.map((m) => (
            <TouchableOpacity
              key={m.value}
              style={[styles.segment, tipMode === m.value && styles.segmentActive]}
              onPress={() => setTipMode(m.value)}
            >
              <Text style={[styles.segmentText, tipMode === m.value && styles.segmentTextActive]}>
                {m.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>
          {tipMode === 'per_hour' ? 'Tips per Hour ($)' : 'Total Tips ($)'}
        </Text>
        <TextInput
          style={styles.input}
          placeholder="0.00"
          placeholderTextColor="#555"
          keyboardType="decimal-pad"
          value={tipInput}
          onChangeText={setTipInput}
        />

        {/* Job picker */}
        {jobs.length > 0 && (
          <>
            <Text style={styles.label}>Job (optional)</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.jobRow}>
              <TouchableOpacity
                style={[styles.jobChip, jobId === null && styles.jobChipActive]}
                onPress={() => setJobId(null)}
              >
                <Text style={[styles.jobChipText, jobId === null && styles.jobChipTextActive]}>
                  None
                </Text>
              </TouchableOpacity>
              {jobs.filter((j) => !j.archived).map((j) => (
                <TouchableOpacity
                  key={j.id}
                  style={[styles.jobChip, jobId === j.id && styles.jobChipActive, jobId === j.id && { backgroundColor: j.color }]}
                  onPress={() => setJobId(j.id)}
                >
                  <Text style={[styles.jobChipText, jobId === j.id && styles.jobChipTextActive]}>
                    {j.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </>
        )}

        <Text style={styles.label}>Notes (optional)</Text>
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          placeholder="Any notes…"
          placeholderTextColor="#555"
          multiline
          numberOfLines={3}
          value={notes}
          onChangeText={setNotes}
        />

        {/* Live preview */}
        <View style={styles.preview}>
          <Text style={styles.previewTitle}>Earnings Preview</Text>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Wages</Text>
            <Text style={styles.previewValue}>${wageTotal.toFixed(2)}</Text>
          </View>
          <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>Tips</Text>
            <Text style={styles.previewValue}>${totalTips.toFixed(2)}</Text>
          </View>
          <View style={[styles.previewRow, styles.previewTotalRow]}>
            <Text style={styles.previewTotalLabel}>Total</Text>
            <Text style={styles.previewTotalValue}>${grandTotal.toFixed(2)}</Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.button, submitting && styles.buttonDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#0d0d0d" />
          ) : (
            <Text style={styles.buttonText}>Save Shift</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#0d0d0d' },
  container: { padding: 20, paddingBottom: 40 },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#f0f0f0',
    marginBottom: 20,
  },
  label: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
    color: '#f0f0f0',
    marginBottom: 16,
  },
  inputMultiline: {
    height: 80,
    textAlignVertical: 'top',
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginBottom: 16,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: '#f5a623',
  },
  segmentText: {
    color: '#777',
    fontSize: 14,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#0d0d0d',
  },
  jobRow: {
    marginBottom: 16,
  },
  jobChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    marginRight: 8,
  },
  jobChipActive: {
    borderColor: '#f5a623',
    backgroundColor: '#f5a623',
  },
  jobChipText: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: '500',
  },
  jobChipTextActive: {
    color: '#0d0d0d',
    fontWeight: '700',
  },
  preview: {
    backgroundColor: '#141414',
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#252525',
  },
  previewTitle: {
    color: '#888',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  previewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  previewLabel: {
    color: '#888',
    fontSize: 14,
  },
  previewValue: {
    color: '#ccc',
    fontSize: 14,
    fontWeight: '500',
  },
  previewTotalRow: {
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
    paddingTop: 10,
    marginTop: 4,
  },
  previewTotalLabel: {
    color: '#f0f0f0',
    fontSize: 16,
    fontWeight: '700',
  },
  previewTotalValue: {
    color: '#f5a623',
    fontSize: 20,
    fontWeight: '700',
  },
  button: {
    backgroundColor: '#f5a623',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: {
    color: '#0d0d0d',
    fontSize: 16,
    fontWeight: '700',
  },
});
