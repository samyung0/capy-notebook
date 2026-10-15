package capy.odl;

import java.io.File;
import org.apache.commons.cli.CommandLine;
import org.apache.commons.cli.DefaultParser;
import org.opendataloader.pdf.api.Config;
import org.opendataloader.pdf.api.cli.CLIOptions;
import org.opendataloader.pdf.processors.DocumentProcessor;
import org.opendataloader.pdf.processors.ExtractionResult;

/**
 * ODL's CLI for one PDF, run as a library: same options and outputs as
 * {@code CLIMain}, then the JVM exits without ODL's static cleanup.
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
        // One document per JVM: exit without ODL's static cleanup.
        System.exit(0);
    }
}
