/**
 * Adapta la estrategia del agente IA según el BelnapAnalysis recibido.
 *
 * Cada cuadrante de Belnap implica un objetivo primario distinto y una
 * lista de sub-objetivos ordenados por prioridad.
 */
import type { BelnapAnalysis, BelnapStrategy } from './types';

const STRATEGIES: Record<
  BelnapAnalysis['consistency'],
  (analysis: BelnapAnalysis) => BelnapStrategy
> = {
  consistent: (analysis) => {
    if (analysis.value === 'T') {
      return {
        primaryGoal:
          'Consolidar la fórmula como axioma y avanzar con el razonamiento.',
        subgoals: [
          'Registrar la fórmula como premisa verificada.',
          'Derivar consecuencias inmediatas.',
          'Actualizar el modelo del mundo con la nueva información.'
        ]
      };
    }
    // value === 'F'
    return {
      primaryGoal:
        'Incorporar la negación de la fórmula y revisar el grafo de dependencias.',
      subgoals: [
        'Añadir ¬fórmula al conjunto de premisas activas.',
        'Identificar hipótesis que dependían de esta fórmula y marcarlas como inválidas.',
        'Propagar el cambio a los nodos dependientes del grafo de conocimiento.'
      ]
    };
  },

  inconsistent: (_analysis) => ({
    primaryGoal:
      'Resolver la contradicción antes de continuar con cualquier inferencia.',
    subgoals: [
      'Identificar las fuentes que afirman y niegan la fórmula simultáneamente.',
      'Aplicar una estrategia de revisión de creencias (contracción AGM).',
      'Dividir la base de conocimiento en sub-teorías consistentes si la contradicción es intractable.',
      'Informar al usuario de la contradicción y solicitar priorización.',
      'Retomar el razonamiento sólo tras alcanzar un estado consistente.'
    ]
  }),

  incomplete: (_analysis) => ({
    primaryGoal:
      'Adquirir información suficiente para determinar el valor de la fórmula.',
    subgoals: [
      'Formular preguntas concretas al usuario o a fuentes externas.',
      'Explorar fórmulas auxiliares que puedan acotar el espacio de valores.',
      'Evaluar si un supuesto de mundo cerrado (CWA) es apropiado para el contexto.',
      'Documentar la incertidumbre y continuar con inferencias que no dependan de esta fórmula.'
    ]
  }),

  undetermined: (_analysis) => ({
    primaryGoal: 'Clarificar el estado lógico de la fórmula antes de usarla.',
    subgoals: [
      'Revisar si el perfil lógico seleccionado es el adecuado para la tarea.',
      'Verificar si la fórmula está bien formada bajo el perfil activo.',
      'Intentar con un perfil alternativo o con información de contexto adicional.',
      'Escalar al usuario si el estado permanece indeterminado tras la revisión.'
    ]
  })
};

/**
 * Genera una estrategia de acción para el agente IA a partir del análisis
 * Belnap previo.
 *
 * @param analysis - Resultado devuelto por `analyzeBelnap`.
 * @returns Estrategia con objetivo primario y sub-objetivos ordenados.
 */
export function adaptStrategy(analysis: BelnapAnalysis): BelnapStrategy {
  const builder = STRATEGIES[analysis.consistency];
  return builder(analysis);
}
