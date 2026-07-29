import {
  deleteDoc,
  doc,
  getDoc,
  increment,
  serverTimestamp,
  setDoc,
  type Firestore,
} from 'firebase/firestore'

export type EditaskFile = {
  name: string
  content: string
  revision: number
  updatedAt?: unknown
}

export async function deleteFile(db: Firestore, uid: string, fileName: string): Promise<void> {
  await deleteDoc(fileDoc(db, uid, fileName))
}

function fileDoc(db: Firestore, uid: string, fileName: string) {
  return doc(db, 'users', uid, 'files', encodeURIComponent(fileName))
}

export async function loadFile(db: Firestore, uid: string, fileName: string): Promise<EditaskFile> {
  const snapshot = await getDoc(fileDoc(db, uid, fileName))
  if (!snapshot.exists()) {
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
