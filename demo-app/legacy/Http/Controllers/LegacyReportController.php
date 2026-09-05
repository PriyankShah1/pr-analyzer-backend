<?php

namespace App\Http\Controllers;

use App\Services\ReportBuilder;
use Illuminate\Http\Request;

class LegacyReportController extends Controller
{
    public function monthly(Request $request)
    {
        $builder = new ReportBuilder();
        $rows = $builder->collect($request->input('month'));

        return response()->json($rows);
    }

    public function export(Request $request)
    {
        $rows = DB::select("SELECT * FROM invoices ORDER BY issued_at DESC");

        return response()->json($rows);
    }
}
