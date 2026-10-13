package capy.odl;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.apache.commons.cli.CommandLine;
import org.apache.commons.cli.DefaultParser;
import org.opendataloader.pdf.api.Config;
import org.opendataloader.pdf.api.cli.CLIOptions;
import org.opendataloader.pdf.processors.DocumentProcessor;
import org.opendataloader.pdf.processors.ExtractionResult;
import org.verapdf.wcag.algorithms.entities.IObject;
import org.verapdf.wcag.algorithms.entities.ObjectKey;
import org.verapdf.wcag.algorithms.entities.SemanticHeaderOrFooter;
import org.verapdf.wcag.algorithms.entities.SemanticTOC;
import org.verapdf.wcag.algorithms.entities.SemanticTOCI;
import org.verapdf.wcag.algorithms.entities.content.ImageChunk;
import org.verapdf.wcag.algorithms.entities.lists.ListItem;
import org.verapdf.wcag.algorithms.entities.lists.PDFList;
import org.verapdf.wcag.algorithms.entities.tables.tableBorders.TableBorder;
import org.verapdf.wcag.algorithms.semanticalgorithms.utils.StreamInfo;

/**
 * ODL's CLI for one PDF, run as a library, plus what its JSON leaves out.
 *
 * <p>Same options and outputs as {@code CLIMain}. It also writes
 * {@code capy-images.json} beside the JSON: the PDF object number of the image
 * each picture element (by its JSON id) draws. veraPDF already resolved it while
 * parsing; without it the parser replays every page in MuPDF to find the images
 * again. Inline images have no object and are left out.
 */
public final class CapyMain {
    private CapyMain() {}

    public static void main(String[] args) throws Exception {
        CommandLine line = new DefaultParser().parse(CLIOptions.defineOptions(), args);
        if (line.getArgs().length != 1) {
            throw new IllegalArgumentException("expected one PDF");
        }
        Config config = CLIOptions.createConfigFromCommandLine(line);
        String pdf = new File(line.getArgs()[0]).getAbsolutePath();
        ExtractionResult result = DocumentProcessor.extractContents(pdf, config);
        DocumentProcessor.generateOutputs(
            pdf, result.getContents(), config, result.getElementMetadata());
        Map<Long, Integer> objects = new TreeMap<>();
        for (List<IObject> page : result.getContents()) {
            collect(page, objects);
        }
        StringBuilder json = new StringBuilder("{");
        for (Map.Entry<Long, Integer> entry : objects.entrySet()) {
            if (json.length() > 1) {
                json.append(',');
            }
            json.append('"').append(entry.getKey()).append("\":").append(entry.getValue());
        }
        write(Path.of(config.getOutputFolder(), "capy-images.json"), json.append('}').toString());
        // One document per JVM: exit without ODL's static cleanup.
        System.exit(0);
    }

    /** The containers DocumentProcessor.setIDs numbers, walked the same way. */
    private static void collect(List<IObject> contents, Map<Long, Integer> objects) {
        for (IObject object : contents) {
            if (object instanceof ImageChunk && object.getRecognizedStructureId() != null) {
                for (StreamInfo info : object.getStreamInfos()) {
                    ObjectKey key = info.getXImageObjectKey();
                    if (key != null) {
                        objects.put(object.getRecognizedStructureId(), key.getNumber());
                        break;
                    }
                }
            } else if (object instanceof TableBorder) {
                TableBorder table = (TableBorder) object;
                for (int row = 0; row < table.getNumberOfRows(); row++) {
                    for (int col = 0; col < table.getNumberOfColumns(); col++) {
                        var cell = table.getRow(row).getCell(col);
                        if (cell.getRowNumber() == row && cell.getColNumber() == col) {
                            collect(cell.getContents(), objects);
                        }
                    }
                }
            } else if (object instanceof PDFList) {
                for (ListItem item : ((PDFList) object).getListItems()) {
                    collect(item.getContents(), objects);
                }
            } else if (object instanceof SemanticTOC) {
                for (IObject item : ((SemanticTOC) object).getTOCItems()) {
                    if (item instanceof SemanticTOCI) {
                        collect(((SemanticTOCI) item).getContents(), objects);
                    }
                }
            } else if (object instanceof SemanticHeaderOrFooter) {
                collect(((SemanticHeaderOrFooter) object).getContents(), objects);
            }
        }
    }

    private static void write(Path path, String text) throws IOException {
        Files.writeString(path, text, StandardCharsets.UTF_8);
    }
}
