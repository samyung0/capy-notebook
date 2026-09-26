"""Build cumulative edit rounds of the probe chapter and book as HTML.

Round 0 is the probe HTML as built for the reparse report. Each later round
applies one content edit on top of the previous round: add a new section,
replace a case study, remove sections, 20 one-word fixes, add another section,
and (book only) remove a whole chapter. The ground truth of every round goes to
rounds.json for the judge. Conversion to DOCX and parsing happen elsewhere.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROBE = HERE.parent / "probe"
WORK = HERE / "work"


def p(text: str) -> str:
    return f"<p>{html.escape(text)}</p>"


def h(level: int, text: str) -> str:
    return f"<h{level}>{html.escape(text)}</h{level}>"


def heading_index(lines: list[str], title: str, start: int = 0) -> int:
    for i in range(start, len(lines)):
        if re.match(r"<h[1-4][^>]*>", lines[i]) and re.sub(
            r"<[^>]+>", "", lines[i]
        ).strip().startswith(title):
            return i
    raise KeyError(title)


def next_heading(lines: list[str], start: int, levels: str) -> int:
    for i in range(start + 1, len(lines)):
        if re.match(rf"<h[{levels}][^>]*>", lines[i]):
            return i
    return len(lines) - 1  # the closing body/html tail sits on the last line


def scattered(lines: list[str]) -> list[str]:
    """20 one-word fixes spread through the body, as in the reparse probe."""
    body = [
        i
        for i, line in enumerate(lines)
        if line.startswith("<p>")
        and 250 <= len(re.sub(r"<[^>]+>", "", line)) <= 900
        and not re.sub(r"<[^>]+>", "", line)[:1].isdigit()
        and re.search(r"\bthe\b", line)
    ]
    out = list(lines)
    for k in range(20):
        i = body[int(((k + 0.5) / 20) * len(body))]
        out[i] = re.sub(r"\bthe\b", "this", out[i], count=1)
    return out


# ------------------------------------------------------------ new content

KDE = [
    h(3, "2.1.9 Kernel density estimates and violin plots"),
    p(
        "A histogram depends on where its bins start and how wide they are. Two analysts who bin the same loan interest rates differently can see different shapes: one sees a single peak, the other sees two. A kernel density estimate (KDE) avoids the choice of bin edges. It places a small, smooth bump, called a kernel, on top of every observation and adds the bumps together. The most common kernel is the normal (Gaussian) curve, and the resulting curve is scaled so that the total area under it equals 1, which lets us read it the same way as a density histogram."
    ),
    p(
        "The width of each bump is set by the bandwidth. A small bandwidth follows the data closely and produces a wiggly curve with many local peaks, while a large bandwidth smooths away real features such as a second mode. A widely used default is Silverman's rule of thumb, which sets the bandwidth to 0.9 times the smaller of the standard deviation and the interquartile range divided by 1.34, multiplied by the sample size raised to the power -1/5. The rule works well for roughly bell-shaped data and tends to oversmooth data with several modes, so it is worth plotting two or three bandwidths before settling on one."
    ),
    p("EXAMPLE 2.20 START"),
    p(
        "Example problem: The 50 interest rates in the loan data have a standard deviation of 5.0% and an IQR of 5.8%. What bandwidth does Silverman's rule give?"
    ),
    p(
        "Solution to the example: The IQR divided by 1.34 is 4.33, which is smaller than 5.0, and 50 raised to the power -1/5 is 0.457. The bandwidth is 0.9 x 4.33 x 0.457, or about 1.78 percentage points."
    ),
    p("EXAMPLE 2.20 HAS ENDED."),
    p(
        "A violin plot combines a box plot with a kernel density estimate. The density is mirrored on both sides of a vertical axis, so the outline looks like a violin, and a thin box plot is often drawn inside it. Placing violins side by side makes it easy to compare the shape of a numerical variable across groups: a violin with two bulges reveals a bimodal distribution that an ordinary box plot would hide, because two distributions with the same quartiles can have very different shapes."
    ),
    p(
        "Kernel density estimates have limitations. Near a hard boundary, such as an interest rate that cannot be negative or a proportion that must lie between 0 and 1, the smooth bumps spill past the boundary and put density where no data can occur. With small samples, a KDE can suggest structure that is only noise. For these reasons we treat KDEs and violin plots as exploratory tools: they help us see the shape of the data, but conclusions about the population still require the inferential methods introduced in later chapters."
    ),
    p("GUIDED PRACTICE 2.21 START"),
    p(
        "If you halve the bandwidth of a kernel density estimate, would you expect the number of local peaks to increase or decrease? Each bump becomes narrower and follows individual observations more closely, so the number of local peaks usually increases."
    ),
    p("GUIDED PRACTICE 2.21 HAS ENDED."),
]

SLEEP = [
    h(2, "2.3 Case study: sleep deprivation and reaction time"),
    p(
        "Researchers studying fatigue recruited 24 volunteers and randomly assigned 12 of them to stay awake for 24 hours while the other 12 slept normally. The next morning every participant completed a driving-simulator task, and the researchers recorded whether the participant's average reaction time to a sudden obstacle was slower than 500 milliseconds, a threshold the investigators considered unsafe."
    ),
    p(
        "Of the 12 sleep-deprived participants, 10 reacted slowly and 2 did not. Of the 12 rested participants, 4 reacted slowly and 8 did not. In total, 14 of the 24 participants reacted slowly."
    ),
    p("Figure 2.29: Summary results for the sleep deprivation experiment."),
    p("GUIDED PRACTICE 2.32 START"),
    p(
        "Is this an observational study or an experiment? Because the volunteers were randomly assigned to the two groups, it is an experiment, and a real difference between the groups could be attributed to sleep deprivation."
    ),
    p("GUIDED PRACTICE 2.32 HAS ENDED."),
    p(
        "The proportion of slow reactions was 83.3% in the sleep-deprived group and 33.3% in the rested group, a difference of 50 percentage points. With only 24 participants, the difference might still be due to chance. We compare two competing claims."
    ),
    p(
        "H0: Independence model. Sleep deprivation and reaction speed are independent, and the observed difference arose from the random assignment alone."
    ),
    p(
        "HA: Alternative model. Sleep deprivation slows reactions, and the 50% difference reflects that effect."
    ),
    h(3, "2.3.2 Simulating the study"),
    p(
        "If the independence model is true, 14 participants would have reacted slowly whatever group they were in. We can simulate the random assignment by writing slow on 14 index cards and not slow on 10, shuffling them, and dealing 12 cards to a simulated sleep-deprived group and 12 to a simulated rested group. One such shuffle produced 8 slow reactions in the deprived group and 6 in the rested group, a difference of 8/12 - 6/12 = 16.7%."
    ),
    h(3, "2.3.3 Checking for independence"),
    p(
        "Repeating the shuffle 1,000 times with a computer gives the distribution of differences we would expect from chance alone. This permutation distribution is centered at zero. Only 18 of the 1,000 simulated differences were at least 50%, so under the independence model a difference this large would occur about 1.8% of the time. Because this is a rare event, the data provide convincing evidence against the independence model, and we conclude that sleep deprivation slowed reaction times in this experiment. The participants were volunteers, so generalizing the result to all drivers requires caution."
    ),
]

CRAMER = [
    h(3, "2.2.7 Measuring association with Cramer's V"),
    p(
        "Row and column proportions show whether two categorical variables appear to be associated, but they do not summarize the strength of the association in a single number. Cramer's V does. It is computed from the chi-square statistic of a contingency table, which compares each observed count with the count we would expect if the variables were independent; Chapter 6 develops this statistic in detail. For a table with r rows, c columns and n observations, V is the square root of the chi-square statistic divided by n(k - 1), where k is the smaller of r and c."
    ),
    p(
        "Cramer's V always lies between 0 and 1. A value of 0 means the row proportions are identical, so knowing one variable tells us nothing about the other, and a value of 1 means one variable perfectly predicts the other. Rough guidelines call values below 0.1 negligible, around 0.3 moderate and above 0.5 strong, but these labels depend on the field."
    ),
    p("EXAMPLE 2.29 START"),
    p(
        "Example problem: A table of 400 loans cross-classifies homeownership (rent, mortgage, own) by application type (individual, joint), and its chi-square statistic is 14.4. What is Cramer's V?"
    ),
    p(
        "Solution to the example: The smaller dimension is k = 2, so V is the square root of 14.4 / (400 x 1), the square root of 0.036, or about 0.19: a weak association."
    ),
    p("EXAMPLE 2.29 HAS ENDED."),
    p(
        "Two cautions apply. Cramer's V says nothing about the direction or the pattern of the association, so the row and column proportions are still needed to describe which categories go together. And a moderate V computed from a small sample may not reflect a real association in the population; whether an observed association is larger than chance alone would produce is a question for the hypothesis tests of Chapter 6."
    ),
]

BOOTSTRAP = [
    h(2, "5.4 Bootstrap confidence intervals"),
    p(
        "The confidence intervals in Section 5.2 rely on the normal model for the sampling distribution of a proportion, which requires the success-failure condition. When that condition fails, or when the statistic of interest has no simple formula for its standard error, such as a median or a ratio, we can use the bootstrap."
    ),
    h(3, "5.4.1 The bootstrap idea"),
    p(
        "The sample is our best picture of the population. Bootstrapping treats the sample as if it were the population and imitates the sampling process by resampling from it. A bootstrap sample has the same size n as the original sample and is drawn with replacement, so some observations appear several times and others not at all. Computing the statistic on each of many bootstrap samples gives a bootstrap distribution, whose spread approximates the sampling variability of the statistic."
    ),
    h(3, "5.4.2 The percentile method"),
    p(
        "Suppose a survey of 40 households records weekly grocery spending and the sample median is $142. To build a 95% bootstrap interval for the population median, we draw 10,000 bootstrap samples of 40 households each, compute the median of each, and sort the 10,000 medians. The 2.5th and 97.5th percentiles of this bootstrap distribution, $128 and $159, form the 95% percentile interval: we are 95% confident that the median weekly grocery spending in the population is between $128 and $159."
    ),
    h(3, "5.4.3 The bootstrap standard error"),
    p(
        "Alternatively, the standard deviation of the bootstrap distribution estimates the standard error of the statistic. When the bootstrap distribution is roughly symmetric and bell-shaped, an interval of the form point estimate plus or minus 1.96 bootstrap standard errors gives results close to the percentile interval."
    ),
    h(3, "5.4.4 When the bootstrap fails"),
    p(
        "The bootstrap cannot fix a biased sample: resampling a convenience sample only reproduces its bias. It also performs poorly for very small samples, for statistics that depend on extreme values such as the maximum, and for observations that are not independent, such as measurements collected over time. In those cases the resampling must be adapted to the structure of the data or another method is needed."
    ),
    p("GUIDED PRACTICE 5.30 START"),
    p(
        "Why must bootstrap samples be drawn with replacement? Without replacement, every bootstrap sample of size n would be a rearrangement of the original sample, and every bootstrap statistic would equal the original statistic."
    ),
    p("GUIDED PRACTICE 5.30 HAS ENDED."),
]

HOMES = [
    h(2, "9.4 Multiple regression case study: home prices"),
    p(
        "In this case study we model the sale price of houses in a mid-sized city using 1,200 sales from one year. The response is the sale price in thousands of dollars. The candidate predictors are the living area in square feet, the number of bedrooms, the age of the house in years, whether the house has a garage (coded 1 for yes), and the neighborhood's school rating on a 1 to 10 scale."
    ),
    h(3, "9.4.1 The full model"),
    p(
        "Fitting all five predictors gives predicted price = 38.2 + 0.112 x area - 6.4 x bedrooms - 0.85 x age + 21.7 x garage + 9.3 x school rating, with an adjusted R-squared of 0.71. The negative coefficient for bedrooms surprises many readers. It does not mean that adding a bedroom lowers the value of a house: holding living area fixed, more bedrooms means smaller rooms, and buyers pay less for the same space divided into more pieces. Each coefficient must be interpreted with the other variables held constant."
    ),
    h(3, "9.4.2 Model selection"),
    p(
        "With backward elimination using adjusted R-squared, removing any single predictor lowers the adjusted R-squared, so all five are kept. With p-values, the bedrooms coefficient has a p-value of 0.03 and every other predictor has a p-value below 0.001, so the same model is selected."
    ),
    h(3, "9.4.3 Checking conditions"),
    p(
        "A plot of the residuals against the fitted values shows a fan shape: the residuals spread out as the predicted price increases, which violates the constant variability condition. Refitting the model with the natural logarithm of price as the response removes most of the fan shape. In the log model each coefficient describes an approximate percentage change; the garage coefficient of 0.083 means that, other things equal, houses with a garage sold for about 8.7% more."
    ),
    h(3, "9.4.4 Using the model"),
    p(
        "For a 20-year-old, three-bedroom house of 1,800 square feet with a garage in a neighborhood rated 7, the original model predicts 38.2 + 0.112(1800) - 6.4(3) - 0.85(20) + 21.7(1) + 9.3(7) = 290.4, or about $290,000. Because the conditions check revealed non-constant variability, predictions for expensive homes should use the log model and be reported with wider intervals."
    ),
]

TRANSFORM = [
    h(2, "8.5 Transformations for nonlinear relationships"),
    p(
        "The least squares line describes a linear trend. When a scatterplot shows a curved pattern, or when the residuals from a linear fit show a systematic bend, a transformation of one or both variables can often make the relationship linear."
    ),
    h(3, "8.5.1 Common transformations"),
    p(
        "The most common choice is the natural logarithm. Taking the log of the response is useful when the response grows multiplicatively, for example when income, population or prices increase by a roughly constant percentage for each unit of the predictor. Taking the log of the predictor helps when the response increases quickly at first and then levels off. Square roots are a milder transformation often used for counts, and the reciprocal is used for rates such as time per task."
    ),
    h(3, "8.5.2 Interpreting a log-transformed model"),
    p(
        "In a model that predicts log(y) as b0 + b1 x, an increase of one unit in x multiplies the predicted value of y by e raised to b1, which for small b1 is approximately a change of 100 b1 percent. If the log of annual salary is modeled against years of experience with b1 = 0.04, each additional year is associated with a salary about 4% higher. In a model where both variables are logged, b1 is an elasticity: a 1% increase in x is associated with approximately a b1% change in y."
    ),
    h(3, "8.5.3 Cautions"),
    p(
        "A transformation changes the question being answered. Predictions made on the log scale must be transformed back with the exponential function, and the back-transformed value estimates a typical (median) response rather than the mean. Transformations cannot fix every problem: if the residuals from the transformed model still show a pattern, a different transformation or a model with more predictors may be needed, and the choice should follow the residual plots rather than trying transformations until one gives the largest R-squared."
    ),
]


# ------------------------------------------------------------------ rounds


def chapter_rounds(lines: list[str]) -> list[tuple[str, str, list[str]]]:
    rounds = [("c0", "Base chapter (Summarizing data).", lines)]
    cur = list(lines)
    # c1: new subsection at the end of 2.1, before its Exercises.
    i = heading_index(cur, "2.1.8 Mapping data")
    ex = next_heading(cur, i, "1-4")
    cur = cur[:ex] + KDE + cur[ex:]
    rounds.append(
        (
            "c1",
            "Added subsection 2.1.9 on kernel density estimates (bandwidth, Silverman's rule of thumb) and violin plots.",
            cur,
        )
    )
    # c2: replace the malaria vaccine case study (up to its Exercises).
    i = heading_index(cur, "2.3 Case study: malaria vaccine")
    j = i
    while True:
        j = next_heading(cur, j, "1-4")
        if "Exercises" in cur[j]:
            break
    cur = cur[:i] + SLEEP + cur[j:]
    rounds.append(
        (
            "c2",
            "Replaced the case study in Section 2.3: the malaria vaccine (PfSPZ) study is gone; the new case study is a randomized sleep deprivation experiment on reaction time analyzed with a permutation (card-shuffling) simulation, difference of 50 percentage points, about 1.8% of simulations as extreme. Exercises after the section are unchanged and may still mention earlier examples.",
            cur,
        )
    )
    # c3: remove mosaic plots and the pie chart subsections.
    i = heading_index(cur, "2.2.4 Mosaic plots")
    j = heading_index(cur, "2.2.6 Comparing numerical data")
    cur = cur[:i] + cur[j:]
    rounds.append(
        (
            "c3",
            "Removed subsections 2.2.4 Mosaic plots and 2.2.5 on pie charts. One chapter exercise still mentions a mosaic plot.",
            cur,
        )
    )
    # c4: twenty one-word fixes.
    cur = scattered(cur)
    rounds.append(
        (
            "c4",
            "Twenty one-word wording fixes ('the' to 'this') spread through the chapter; no topic changed.",
            cur,
        )
    )
    # c5: new subsection at the end of 2.2, before its Exercises.
    i = heading_index(cur, "2.2.6 Comparing numerical data")
    ex = next_heading(cur, i, "1-4")
    cur = cur[:ex] + CRAMER + cur[ex:]
    rounds.append(
        (
            "c5",
            "Added subsection 2.2.7 on Cramer's V as a measure of association strength between categorical variables.",
            cur,
        )
    )
    return rounds


def book_rounds(lines: list[str]) -> list[tuple[str, str, list[str]]]:
    rounds = [
        (
            "b0",
            "Base book (OpenIntro Statistics text, chapters 1-9 plus exercise answers).",
            lines,
        )
    ]
    cur = list(lines)
    i = heading_index(cur, "Chapter 6:")
    cur = cur[:i] + BOOTSTRAP + cur[i:]
    rounds.append(
        (
            "b1",
            "Added Section 5.4 on bootstrap confidence intervals (resampling with replacement, percentile method, bootstrap standard error, when the bootstrap fails).",
            cur,
        )
    )
    i = heading_index(cur, "9.4 Multiple regression case study: Mario Kart")
    j = heading_index(cur, "9.5 Introduction to logistic regression")
    cur = cur[:i] + HOMES + cur[j:]
    rounds.append(
        (
            "b2",
            "Replaced the Section 9.4 case study: the Mario Kart eBay auction case study is gone; the new case study models home sale prices (area, bedrooms, age, garage, school rating), backward elimination, a fan-shaped residual plot fixed with log(price).",
            cur,
        )
    )
    i = heading_index(cur, "4.4 Negative binomial distribution")
    j = heading_index(cur, "4.5 Poisson distribution")
    cur = cur[:i] + cur[j:]
    rounds.append(
        (
            "b3",
            "Removed Section 4.4 on the negative binomial distribution. The exercise answers at the end of the book are unchanged.",
            cur,
        )
    )
    cur = scattered(cur)
    rounds.append(
        (
            "b4",
            "Twenty one-word wording fixes ('the' to 'this') spread through the book; no topic changed.",
            cur,
        )
    )
    i = heading_index(cur, "Chapter 9:")
    cur = cur[:i] + TRANSFORM + cur[i:]
    rounds.append(
        (
            "b5",
            "Added Section 8.5 on transformations for nonlinear relationships (log transforms, percentage and elasticity interpretation, back-transformation cautions).",
            cur,
        )
    )
    i = heading_index(cur, "Chapter 3:")
    j = heading_index(cur, "Chapter 4:")
    cur = cur[:i] + cur[j:]
    rounds.append(
        (
            "b6",
            "Removed all of Chapter 3 (Probability: defining probability, conditional probability and Bayes' theorem, sampling from a small population, random variables, continuous distributions). The exercise answers at the end of the book still include chapter 3 answers.",
            cur,
        )
    )
    return rounds


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, builder in (("chapter", chapter_rounds), ("book", book_rounds)):
        lines = (PROBE / f"{name}.html").read_text(encoding="utf-8").split("\n")
        for key, change, state in builder(lines):
            out = WORK / f"{key}.html"
            out.write_text("\n".join(state), encoding="utf-8")
            words = sum(len(re.sub(r"<[^>]+>", " ", x).split()) for x in state)
            manifest.append(
                {
                    "doc": name,
                    "round": key,
                    "change": change,
                    "words": words,
                    "html": out.name,
                }
            )
            print(key, words)
    (HERE / "rounds.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
