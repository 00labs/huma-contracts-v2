describe("Lender Integration Tests", function () {
    describe("With FixedYieldTranchesPolicy", function () {
        it("Day 0: Lenders provides liquidity and the borrower makes initial drawdown", async function () {});

        it("Day 30: 1st payment by the borrower and distribution of profit", async function () {});

        it("Day 35: Lenders in both tranches request redemption", async function () {});

        it("Day 40: Senior lenders put in additional redemption requests", async function () {});

        it("Day 60: 2nd payment by the borrower and the fulfillment of the redemption requests", async function () {
            // All redemption requests are fulfilled.
        });

        it("Day 65: New senior lenders inject liquidity", async function () {});

        it("Day 70: Senior lenders attempts to inject liquidity, but blocked by senior : junior ratio", async function () {});

        it("Day 75: New junior lenders inject liquidity", async function () {});

        it("Day 80: Senior lenders are now able to inject additional liquidity", async function () {});

        it("Day 85: Junior lenders add redemption request", async function () {});

        it("Day 90: No payment from the borrower, hence no fulfillment of the junior redemption requests", async function () {});

        it("Day 95: Late 3rd payment", async function () {});

        it("Day 120: No payment from the borrower, so only partial fulfillment of the junior redemption requests", async function () {});

        it("Day 130: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {});

        it("Day 150: 4th payment and partial fulfillment of junior redemption requests", async function () {
            // The remaining requests are blocked by senior: junior ratio.
        });

        it("Day 170: Senior lenders request redemption", async function () {});

        it("Day 180: 5th payment and complete fulfillment of all redemption requests", async function () {});

        it("Day 270: Default triggered due to late payment, markdown commences", async function () {});

        it("Day 275: Lenders in both tranches submit redemption requests", async function () {});

        it("Day 300: First loss capital kicks in. Redemption requests are fulfilled without loss", async function () {});

        it("Day 307: More redemption requests are submitted", async function () {});

        it("Day 330: Junior tranche suffers loss, redemption requests are fulfilled after the loss materializes", async function () {});

        it("Day 333: More redemption requests are submitted", async function () {});

        it("Day 360: Senior tranche suffers loss, redemption requests are fulfilled after the loss materializes", async function () {});

        it("Day 361: The borrower makes some payment back", async function () {});

        it("Day 375: More redemption requests are submitted", async function () {});

        it("Day 390: Some redemption requests are fulfilled with some loss recovered", async function () {});

        it("Day 393: The borrower makes full payment", async function () {});

        it("Day 395: More redemption requests are submitted", async function () {});

        it("Day 420: Redemption requests are fulfilled", async function () {});
    });

    describe("With RiskAdjustedTranchesPolicy", function () {
        it("Day 0: Lenders provides liquidity and the borrower makes initial drawdown", async function () {});

        it("Day 30: 1st payment by the borrower and distribution of profit", async function () {});

        it("Day 35: Lenders in both tranches request redemption", async function () {});

        it("Day 40: Senior lenders put in additional redemption requests", async function () {});

        it("Day 60: 2nd payment by the borrower and the fulfillment of the redemption requests", async function () {
            // All redemption requests are fulfilled.
        });

        it("Day 65: New senior lenders inject liquidity", async function () {});

        it("Day 70: Senior lenders attempts to inject liquidity, but blocked by senior : junior ratio", async function () {});

        it("Day 75: New junior lenders inject liquidity", async function () {});

        it("Day 80: Senior lenders are now able to inject additional liquidity", async function () {});

        it("Day 85: Junior lenders add redemption request", async function () {});

        it("Day 90: No payment from the borrower, hence no fulfillment of the junior redemption requests", async function () {});

        it("Day 95: Late 3rd payment", async function () {});

        it("Day 120: No payment from the borrower, so only partial fulfillment of the junior redemption requests", async function () {});

        it("Day 130: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {});

        it("Day 150: 4th payment and partial fulfillment of junior redemption requests", async function () {
            // The remaining requests are blocked by senior: junior ratio.
        });

        it("Day 170: Senior lenders request redemption", async function () {});

        it("Day 180: 5th payment and complete fulfillment of all redemption requests", async function () {});

        it("Day 270: Default triggered due to late payment, markdown commences", async function () {});

        it("Day 275: Lenders in both tranches submit redemption requests", async function () {});

        it("Day 300: First loss capital kicks in. Redemption requests are fulfilled without loss", async function () {});

        it("Day 307: More redemption requests are submitted", async function () {});

        it("Day 330: Junior tranche suffers loss, redemption requests are fulfilled after the loss materializes", async function () {});

        it("Day 333: More redemption requests are submitted", async function () {});

        it("Day 360: Senior tranche suffers loss, redemption requests are fulfilled after the loss materializes", async function () {});

        it("Day 361: The borrower makes some payment back", async function () {});

        it("Day 375: More redemption requests are submitted", async function () {});

        it("Day 390: Some redemption requests are fulfilled with some loss recovered", async function () {});

        it("Day 393: The borrower makes full payment", async function () {});

        it("Day 395: More redemption requests are submitted", async function () {});

        it("Day 420: Redemption requests are fulfilled", async function () {});
    });
});
