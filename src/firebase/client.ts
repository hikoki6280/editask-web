import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { hasFirebaseEnv, readFirebaseEnv } from './config'

const firebaseConfig = readFirebaseEnv()

export const firebaseEnabled = hasFirebaseEnv(firebaseConfig)

export const firebaseApp = firebaseEnabled ? initializeApp(firebaseConfig) : undefined
export const auth = firebaseApp ? getAuth(firebaseApp) : undefined
export const googleProvider = new GoogleAuthProvider()
export const db = firebaseApp ? getFirestore(firebaseApp) : undefined
