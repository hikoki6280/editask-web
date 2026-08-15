import {
  doc,
  getDoc,
  increment,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore'
import { createDefaultTemplateContent } from '../domain/defaultTemplate'

export type EditaskFile = {
  name: string
  content: string
  revision: number
  updatedAt?: unknown
}

function fileDoc(db: Firestore, uid: string, fileName: string) {
  return doc(db, 'users', uid, 'files', encodeURIComponent(fileName))
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
          await setDoc(targetRef, {
            name: fileName,
            content: defaultContent,
            revision: 1,
            updatedAt: serverTimestamp(),
          })
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
      await setDoc(defaultRef, { ...initialFile, name: 'default' }, { merge: false })
      await setDoc(targetRef, initialFile, { merge: false })
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
  await setDoc(
    fileDoc(db, uid, fileName),
    {
      name: fileName,
      content,
      revision: increment(1),
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
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

  await setDoc(targetRef, {
    name: fileName,
    content: defaultContent,
    revision: 1,
    updatedAt: serverTimestamp(),
  })
  return true
}
