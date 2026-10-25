<?php
// Replays ADAPT's Canvas QTI import (ProcessValidateQtiFile + QtiImportController::store)
// against an unzipped package, using ADAPT's real app/QtiImport.php parser.
// Only Laravel, the database, and S3 are stubbed. Like Laravel's HandleExceptions,
// every notice/warning becomes an exception, so any "Undefined index" fails the item.
//
// usage: php harness.php <adapt_app_dir> <unzipped_package_dir>

namespace Illuminate\Database\Eloquent { class Model {} }
namespace Illuminate\Support\Facades { class Log { public static function __callStatic($n, $a) {} } }
namespace App\Helpers {
    class Helper {
        // Copied verbatim from adapt/app/Helpers/Helper.php.
        static function removeZerosAfterDecimal($num)
        {
            $pos = strpos($num, '.');
            if ($pos === false) {
                return $num;
            } else {
                return rtrim(rtrim($num, '0'), '.');
            }
        }
    }
}
namespace App {
    class QtiJob { public $qti_directory = 'package'; }
    class Question {
        public $qti_json; public $technology; public $non_technology; public $non_technology_html;
        // adapt/app/Question.php::sendImgsToS3 minus the S3 upload: the same DOM
        // round trip, and any <img> fails because our packages carry no images.
        public function sendImgsToS3(int $user_id, string $dir, string $contents, \DOMDocument $htmlDom): string
        {
            libxml_use_internal_errors(true);
            $htmlDom->loadHTML(mb_convert_encoding($contents, 'HTML-ENTITIES', 'UTF-8'), LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
            libxml_use_internal_errors(false);
            if ($htmlDom->getElementsByTagName('img')->length) {
                throw new \Exception('prompt contains an image, which would be read from the zip');
            }
            return $htmlDom->saveHTML();
        }
    }
}

namespace {
    set_error_handler(function ($level, $message, $file, $line) {
        throw new ErrorException($message, 0, $level, $file, $line);
    });

    [$script, $adaptApp, $dir] = $argv;
    require $adaptApp . '/QtiImport.php';

    $result = ['quizzes' => [], 'items' => [], 'error' => null];
    try {
        // ---- ProcessValidateQtiFile::handle, canvas branch
        if (!file_exists("$dir/imsmanifest.xml")) throw new Exception('No imsmanifest.xml is present.');
        $array = json_decode(json_encode(simplexml_load_file("$dir/imsmanifest.xml")), true);
        $quiz_dirs = [];
        foreach ($array['resources']['resource'] as $resource) {
            if ($resource['@attributes']['type'] === 'associatedcontent/imscc_xmlv1p1/learning-application-resource') {
                $quiz_dirs[] = str_replace('/assessment_meta.xml', '', $resource['@attributes']['href']);
            }
        }
        $items = [];
        foreach ($quiz_dirs as $quiz_dir) {
            if (strpos(file_get_contents("$dir/$quiz_dir/assessment_meta.xml"), 'canvas.instructure.com') === false) {
                throw new Exception('This does not look like a Canvas QTI quiz export.');
            }
            $meta = simplexml_load_file("$dir/$quiz_dir/assessment_meta.xml");
            $result['quizzes'][] = ['dir' => $quiz_dir, 'title' => (string) $meta->title, 'description' => (string) $meta->description];
            $xml = simplexml_load_file("$dir/$quiz_dir/$quiz_dir.xml");
            $section = $xml->assessment->section;
            if ($section->section) $section = $section->section;
            if (!$section->item) throw new Exception('There are no questions to import.');
            foreach ($section->item as $question) {
                $attrs = json_decode(json_encode($question->attributes()), true);
                $items[] = ['identifier' => $attrs['@attributes']['ident'], 'xml' => $question->asXml()];
            }
        }

        // ---- QtiImportController::store, once per item
        foreach ($items as $row) {
            $out = ['identifier' => $row['identifier']];
            // ADAPT keeps only which answers are right, but Canvas adds up the
            // SCORE of each matching term or dropdown blank, so the harness also
            // totals the shares (in hundredths) of the item it imports.
            $setvars = (new SimpleXMLElement($row['xml']))->xpath('.//*[local-name()="setvar"][@varname="SCORE"][@action="Add"]') ?: [];
            $out['score_hundredths'] = array_sum(array_map(function ($setvar) { return (int) round(100 * (float) $setvar); }, $setvars));
            try {
                $qtiImport = new App\QtiImport();
                $qtiImport->xml = $row['xml'];
                $xml = $qtiImport->cleanUpXml($row['xml']);
                $xml_array = json_decode(json_encode($xml), true);
                $out['title'] = $xml_array['@attributes']['title'] ?? 'None provided.';
                $question = new App\Question();
                $info = $qtiImport->processCanvasImport($xml_array, $qtiImport, new App\QtiJob(), 1, new DOMDocument(), $question);
                $qtiImport->updateByQuestionType($question, $info['question_type'], $info['non_technology_html'], $info['xml_array']);
                $out['question_type'] = $info['question_type'];
                $out['message'] = $info['message'];
                $out['technology'] = $question->technology;
                $out['qti_json'] = $question->qti_json === null ? null : json_decode($question->qti_json, true);
                $out['non_technology_html'] = $question->non_technology_html;
                $out['status'] = 'success';
            } catch (Throwable $e) {
                $out['status'] = 'error';
                $out['error'] = $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine();
            }
            $result['items'][] = $out;
        }
    } catch (Throwable $e) {
        $result['error'] = $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine();
    }
    echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}
