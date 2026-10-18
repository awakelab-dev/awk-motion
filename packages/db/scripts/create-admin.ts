/**
 * Crea (o actualiza) el usuario administrador. La contraseña se escribe en la terminal y nunca
 * queda en el repositorio ni en el historial del shell.
 *
 *   pnpm db:admin                       → leonardojbarreto@gmail.com
 *   pnpm db:admin -- --email otra@x.com
 *
 * Idempotente: si el usuario ya existe, lo deja como admin activo y pregunta si cambiar la contraseña.
 */
import { createDb, ensureUnclassified, hashPassword, passwordProblem } from '../src/index.js';
import { ask, askHidden } from './tty.js';

const DEFAULT_ADMIN = 'leonardojbarreto@gmail.com';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function askNewPassword(): Promise<string> {
  for (;;) {
    const a = await askHidden('Contraseña nueva: ');
    const problem = passwordProblem(a);
    if (problem) {
      console.log(problem);
      continue;
    }
    const b = await askHidden('Repite la contraseña: ');
    if (a === b) return a;
    console.log('No coinciden. Otra vez.');
  }
}

async function main() {
  const email = (argValue('--email') ?? DEFAULT_ADMIN).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Email no válido: ${email}`);
  const db = createDb();
  try {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      console.log(`El usuario ${email} ya existe (${existing.role}${existing.active ? '' : ', desactivado'}).`);
      const change = (await ask('¿Cambiar su contraseña? (s/N): ')).toLowerCase();
      const data: { role: 'admin'; active: true; passwordHash?: string } = { role: 'admin', active: true };
      if (change === 's' || change === 'si' || change === 'sí') data.passwordHash = await hashPassword(await askNewPassword());
      await db.user.update({ where: { email }, data });
      await ensureUnclassified(db, existing.id);
      if (data.passwordHash) await db.session.deleteMany({ where: { userId: existing.id } });
      console.log(`✔ ${email} es admin y está activo${data.passwordHash ? '; contraseña cambiada y sesiones cerradas' : ''}.`);
      return;
    }
    console.log(`Creando el administrador ${email}.`);
    const passwordHash = await hashPassword(await askNewPassword());
    const user = await db.user.create({ data: { email, passwordHash, role: 'admin', name: email === DEFAULT_ADMIN ? 'Leonardo' : null } });
    await ensureUnclassified(db, user.id); // hito 4 (ADR-035): todo usuario tiene su "Sin clasificar"
    console.log(`✔ Administrador creado: ${user.email} (id ${user.id}).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
