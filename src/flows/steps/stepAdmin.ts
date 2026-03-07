import { UserState } from '../../types/state';
const { pauseUser } = require('../../services/pauseService');

interface AdminStepDependencies {
    saveState: (userId: string) => void;
    sharedState?: any;
}

export async function handleAdminSteps(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: AdminStepDependencies
): Promise<{ matched: boolean; paused: boolean }> {
    const { saveState } = dependencies;

    // Pedido pendiente de validación manual — el bot se mantiene completamente en silencio.
    // pauseUser maneja debounce, DB y in-memory en un solo lugar.
    await pauseUser(userId, '⌛ Pedido pendiente de validación', { sharedState: dependencies.sharedState });

    // El mensaje del usuario ya fue guardado en salesFlow.ts, no lo duplicamos.
    saveState(userId);

    return { matched: true, paused: true };
}

module.exports = { handleAdminSteps };
