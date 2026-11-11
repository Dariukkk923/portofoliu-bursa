/**
 * Butonul „Import Excel / CSV”: deschide ecranul Import și alegerea fișierului. Acolo aplicația
 * recunoaște extrasul (XTB, Trading 212, Revolut, Interactive Brokers sau orice tabel, cu mapare),
 * arată ce se adaugă și salvează importul ca lot, care poate fi anulat.
 */
import { FileSpreadsheet } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Button } from './ui';

export function ImportButton({ variant = 'secondary' }: { variant?: 'primary' | 'secondary' }) {
  const { requestImport } = useApp();
  return (
    <Button
      variant={variant}
      icon={<FileSpreadsheet className="size-4" />}
      title="Extrasul exportat de la broker (Excel sau CSV) sau un CSV exportat din această aplicație"
      onClick={requestImport}
    >
      Import Excel / CSV
    </Button>
  );
}
