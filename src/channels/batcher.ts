// Junta mensagens que chegam em sequência (álbum de fotos + legenda, várias linhas
// seguidas) e atende uma leva por vez, em ordem: nunca duas levas em paralelo, para
// a memória da conversa e as edições não se atropelarem.
export function createMessageBatcher<T>(
  handler: (items: T[]) => Promise<void>,
  windowMs = 3000,
  onError: (e: unknown) => void = () => {},
): { push: (item: T) => void } {
  let buffer: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const flush = () => {
    timer = null;
    const items = buffer;
    buffer = [];
    if (items.length) chain = chain.then(() => handler(items)).catch(onError);
  };
  return {
    push(item: T) {
      buffer.push(item);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, windowMs);
    },
  };
}
