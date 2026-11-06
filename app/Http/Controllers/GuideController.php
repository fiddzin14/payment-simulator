<?php
namespace App\Http\Controllers;
use Dompdf\Dompdf;
use Dompdf\Options;
class GuideController
{
    private function data(bool $pdf): array
    {
        return [
            'pdf' => $pdf,
            'base' => rtrim(config('app.url'), '/'),
            'diagram' =>
                'data:image/svg+xml;base64,' .
                base64_encode(file_get_contents(public_path('integration-lumen.svg'))),
        ];
    }
    public function show()
    {
        return view('guide', $this->data(false));
    }
    public function pdf()
    {
        $options = new Options();
        $options->set('isRemoteEnabled', false);
        $options->set('isPhpEnabled', false);
        $options->set('defaultFont', 'DejaVu Sans');
        $options->set('defaultMediaType', 'print');
        $options->set('tempDir', storage_path('framework/views'));
        $options->set('fontCache', storage_path('framework/cache/data'));
        $document = new Dompdf($options);
        $document->loadHtml(view('guide', $this->data(true))->render());
        $document->setPaper('a4', 'landscape');
        $document->render();
        return response($document->output(), 200, [
            'Content-Type' => 'application/pdf',
            'Content-Disposition' => 'inline; filename="lumen-gateway-laravel-guide.pdf"',
            'Cache-Control' => 'no-store',
        ]);
    }
}
