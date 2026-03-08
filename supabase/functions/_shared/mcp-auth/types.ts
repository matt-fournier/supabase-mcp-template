/** Identité authentifiée retournée par le middleware. */
export interface AuthIdentity {
  /** Identifiant unique (Supabase user ID ou nom de la clé API). */
  id: string;
  /** Adresse courriel (des claims JWT ou des métadonnées de la clé API). */
  email: string;
  /** Rôle : "user", "admin", "service", etc. */
  role: string;
  /** Méthode d'authentification utilisée. */
  method: "api_key" | "supabase_jwt" | "skip_auth";
}

/** Résultat d'une tentative d'authentification. */
export type AuthResult =
  | { success: true; identity: AuthIdentity }
  | { success: false; error: string; status: number };
