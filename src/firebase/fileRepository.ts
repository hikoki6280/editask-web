import {
  collection,
  doc,
  getDocs,
  getDoc,
  increment,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  writeBatch,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore'
import { createDefaultTemplateContent } from '../domain/defaultTemplate'
import { matchesViewSelector } from '../domain/viewRef'

export type EditaskFile = {
  name: string
  content: string
  revision: number
  updatedAt?: unknown
}

export type EditaskFileIndex = {
  name: string
  updatedAt?: unknown
}

function fileDoc(db: Firestore, uid: string, fileName: string) {
  return doc(db, 'users', uid, 'files', encodeURIComponent(fileName))
}

function fileIndexDoc(db: Firestore, uid: string, fileName: string) {
  return doc(db, 'users', uid, 'fileIndex', encodeURIComponent(fileName))
}

function fileIndexMetaDoc(db: Firestore, uid: string) {
  return doc(db, 'users', uid, 'metadata', 'fileIndex')
}

export async function listFileIndex(db: Firestore, uid: string): Promise<EditaskFileIndex[]> {
  const indexMetaSnapshot = await getDoc(fileIndexMetaDoc(db, uid))
  if (indexMetaSnapshot.data()?.complete === true) {
    const indexSnapshot = await getDocs(collection(db, 'users', uid, 'fileIndex'))
    return indexSnapshot.docs.map((snapshot) => {
      const data = snapshot.data()
      return { name: String(data.name ?? decodeURIComponent(snapshot.id)), updatedAt: data.updatedAt }
    })
  }

  const filesSnapshot = await getDocs(collection(db, 'users', uid, 'files'))
  if (filesSnapshot.empty) {
    const batch = writeBatch(db)
    batch.set(fileIndexMetaDoc(db, uid), { complete: true })
    await batch.commit()
    return []
  }

  const batch = writeBatch(db)
  const files = filesSnapshot.docs.map((snapshot) => {
    const data = snapshot.data()
    const name = String(data.name ?? decodeURIComponent(snapshot.id))
    const updatedAt = data.updatedAt
    batch.set(fileIndexDoc(db, uid, name), { name, updatedAt: updatedAt ?? serverTimestamp() }, { merge: true })
    return { name, updatedAt }
  })
  batch.set(fileIndexMetaDoc(db, uid), { complete: true }, { merge: true })
  await batch.commit()
  return files
}

export async function loadViewFiles(db: Firestore, uid: string, selectors: string[]): Promise<EditaskFile[]> {
  const index = await listFileIndex(db, uid)
  const names = index
    .filter((file) => selectors.some((selector) => matchesViewSelector(file.name, selector)))
    .map((file) => file.name)
  const snapshots = await Promise.all(names.map((name) => getDoc(fileDoc(db, uid, name))))
  return snapshots.flatMap((snapshot, index) => {
    if (!snapshot.exists()) return []
    const data = snapshot.data()
    return [{
      name: String(data.name ?? names[index]),
      content: String(data.content ?? ''),
      revision: Number(data.revision ?? 0),
      updatedAt: data.updatedAt,
    }]
  })
}

export async function loadFile(db: Firestore, uid: string, fileName: string): Promise<EditaskFile> {
  const targetRef = fileDoc(db, uid, fileName)
  const snapshot = await getDoc(targetRef)
  if (!snapshot.exists()) {
    if (fileName === 'main') {
      const defaultRef = fileDoc(db, uid, 'default')
      const defaultSnapshot = await getDoc(defaultRef)
      if (defaultSnapshot.exists()) {
        const defaultData = defaultSnapshot.data()
        const defaultContent = String(defaultData.content ?? '')
        if (defaultContent.trim()) {
          const batch = writeBatch(db)
          batch.set(targetRef, {
            name: fileName,
            content: defaultContent,
            revision: 1,
            updatedAt: serverTimestamp(),
          })
          batch.set(fileIndexDoc(db, uid, fileName), {
            name: fileName,
            updatedAt: serverTimestamp(),
          })
          batch.set(fileIndexDoc(db, uid, 'default'), {
            name: 'default',
            updatedAt: defaultData.updatedAt ?? serverTimestamp(),
          })
          await batch.commit()
          return { name: fileName, content: defaultContent, revision: 1 }
        }
      }

      const content = createDefaultTemplateContent()
      const initialFile = {
        name: fileName,
        content,
        revision: 1,
        updatedAt: serverTimestamp(),
      }
      const batch = writeBatch(db)
      batch.set(defaultRef, { ...initialFile, name: 'default' }, { merge: false })
      batch.set(targetRef, initialFile, { merge: false })
      batch.set(fileIndexDoc(db, uid, 'default'), { name: 'default', updatedAt: serverTimestamp() })
      batch.set(fileIndexDoc(db, uid, fileName), { name: fileName, updatedAt: serverTimestamp() })
      batch.set(fileIndexMetaDoc(db, uid), { complete: true })
      await batch.commit()
      return { name: fileName, content, revision: 1 }
    }
    return { name: fileName, content: '', revision: 0 }
  }

  const data = snapshot.data()
  return {
    name: String(data.name ?? fileName),
    content: String(data.content ?? ''),
    revision: Number(data.revision ?? 0),
    updatedAt: data.updatedAt,
  }
}

export function subscribeFile(
  db: Firestore,
  uid: string,
  fileName: string,
  onChange: (file: EditaskFile) => void,
  onError: () => void,
): Unsubscribe {
  return onSnapshot(
    fileDoc(db, uid, fileName),
    (snapshot) => {
      if (!snapshot.exists()) {
        onChange({ name: fileName, content: '', revision: 0 })
        return
      }

      const data = snapshot.data()
      onChange({
        name: String(data.name ?? fileName),
        content: String(data.content ?? ''),
        revision: Number(data.revision ?? 0),
        updatedAt: data.updatedAt,
      })
    },
    onError,
  )
}

export async function saveFile(
  db: Firestore,
  uid: string,
  fileName: string,
  content: string,
): Promise<void> {
  const batch = writeBatch(db)
  batch.set(
    fileDoc(db, uid, fileName),
    {
      name: fileName,
      content,
      revision: increment(1),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
  batch.set(fileIndexDoc(db, uid, fileName), { name: fileName, updatedAt: serverTimestamp() }, { merge: true })
  await batch.commit()
}

export async function renameFile(db: Firestore, uid: string, fromName: string, toName: string): Promise<void> {
  if (fromName === toName) return

  const sourceRef = fileDoc(db, uid, fromName)
  const targetRef = fileDoc(db, uid, toName)
  await runTransaction(db, async (transaction) => {
    const sourceSnapshot = await transaction.get(sourceRef)
    const targetSnapshot = await transaction.get(targetRef)
    if (!sourceSnapshot.exists()) throw new Error('Rename source file does not exist')
    if (targetSnapshot.exists()) throw new Error('Rename target file already exists')

    const source = sourceSnapshot.data()
    transaction.set(targetRef, {
      name: toName,
      content: String(source.content ?? ''),
      revision: Number(source.revision ?? 0) + 1,
      updatedAt: serverTimestamp(),
    })
    transaction.set(fileIndexDoc(db, uid, toName), { name: toName, updatedAt: serverTimestamp() })
    transaction.delete(sourceRef)
    transaction.delete(fileIndexDoc(db, uid, fromName))
  })
}

export async function deleteFile(db: Firestore, uid: string, fileName: string): Promise<void> {
  const batch = writeBatch(db)
  batch.delete(fileDoc(db, uid, fileName))
  batch.delete(fileIndexDoc(db, uid, fileName))
  await batch.commit()
}

export async function ensureFileFromDefault(
  db: Firestore,
  uid: string,
  fileName: string,
): Promise<boolean> {
  const targetRef = fileDoc(db, uid, fileName)
  const targetSnapshot = await getDoc(targetRef)
  if (targetSnapshot.exists()) return false

  const defaultSnapshot = await getDoc(fileDoc(db, uid, 'default'))
  if (!defaultSnapshot.exists()) return false

  const defaultData = defaultSnapshot.data()
  const defaultContent = String(defaultData.content ?? '')
  if (!defaultContent.trim()) return false

  const batch = writeBatch(db)
  batch.set(targetRef, {
    name: fileName,
    content: defaultContent,
    revision: 1,
    updatedAt: serverTimestamp(),
  })
  batch.set(fileIndexDoc(db, uid, fileName), {
    name: fileName,
    updatedAt: serverTimestamp(),
  })
  await batch.commit()
  return true
}
