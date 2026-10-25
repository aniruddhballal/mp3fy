import { Modal, Text, View } from 'react-native';
import type { Folder } from '../types/domain';
import { ActionButton } from './AppPrimitives';
import { styles } from '../styles/appStyles';

type FolderDialogsProps = {
  folderActions: Folder | null;
  folderToConfirm: Folder | null;
  onCloseActions: () => void;
  onOpenFolder: (folder: Folder) => void;
  onRequestRemove: (folder: Folder | null) => void;
  onRemoveFolder: (folder: Folder) => void;
  onCloseConfirmation: () => void;
};

export function FolderDialogs({ folderActions, folderToConfirm, onCloseActions, onOpenFolder, onRequestRemove, onRemoveFolder, onCloseConfirmation }: FolderDialogsProps) {
  return <>
    <Modal animationType="fade" transparent visible={Boolean(folderActions)} onRequestClose={onCloseActions}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle} numberOfLines={2}>{folderActions?.name}</Text>
          <ActionButton label="OPEN FOLDER" onPress={() => { if (folderActions) onOpenFolder(folderActions); onCloseActions(); }} />
          <ActionButton label="REMOVE FOLDER" onPress={() => { onRequestRemove(folderActions); onCloseActions(); }} secondary />
          <ActionButton label="CANCEL" onPress={onCloseActions} secondary />
        </View>
      </View>
    </Modal>

    <Modal animationType="fade" transparent visible={Boolean(folderToConfirm)} onRequestClose={onCloseConfirmation}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Remove this folder?</Text>
          <Text style={styles.modalDescription}>{folderToConfirm?.name}</Text>
          <ActionButton label="REMOVE FOLDER" onPress={() => { if (folderToConfirm) void onRemoveFolder(folderToConfirm); onCloseConfirmation(); }} />
          <ActionButton label="CANCEL" onPress={onCloseConfirmation} secondary />
        </View>
      </View>
    </Modal>
  </>;
}
