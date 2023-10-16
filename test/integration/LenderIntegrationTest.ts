// For each test, we will have:
// 1 borrower;
// 2 initial lenders in the junior tranche;
// 2 initial lenders in the senior tranche.
// The number of lenders will change as the test progresses.
describe("For pools without flex-loan enabled", function () {
    describe("With FixedYieldTranchesPolicy", function () {
        it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {});

        it("Epoch 0, day 30: 1st payment by the borrower and distribution of profit", async function () {});

        it("Epoch 1, day 35: Lenders in both tranches request redemption", async function () {});

        it("Epoch 1, day 40: Senior lenders put in additional redemption requests", async function () {});

        it("Epoch 1, day 60: 2nd payment by the borrower and the fulfillment of the redemption requests", async function () {
            // All redemption requests are fulfilled.
        });

        it("Epoch 2, day 65: New senior lenders inject liquidity", async function () {});

        it("Epoch 2, day 70: Senior lenders attempts to inject liquidity, but blocked by senior : junior ratio", async function () {});

        it("Epoch 2, day 75: New junior lenders inject liquidity", async function () {});

        it("Epoch 2, day 80: Senior lenders are now able to inject additional liquidity", async function () {});

        it("Epoch 2, day 85: Junior lenders add redemption request", async function () {});

        it("Epoch 2, day 90: No payment from the borrower, hence no fulfillment of the junior redemption requests", async function () {});

        it("Epoch 3, day 95: Late 3rd payment", async function () {});

        it("Epoch 3, day 120: No payment from the borrower, so only partial fulfillment of the junior redemption requests", async function () {});

        it("Epoch 4, day 130: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {});

        it("Epoch 4, day 150: 4th payment and partial fulfillment of junior redemption requests", async function () {
            // The remaining requests are blocked by senior: junior ratio.
        });

        it("Epoch 5, day 170: Senior lenders request redemption", async function () {});

        it("Epoch 5, day 180: 5th payment and complete fulfillment of all redemption requests", async function () {});

        it("Epoch 8, day 270: Default triggered due to late payment", async function () {});

        it("Epoch 9, day 275: Lenders in both tranches submit redemption requests, loss materializes and first loss cover kicks in", async function () {});

        it("Epoch 9, day 300: Redemption requests are fulfilled without loss", async function () {});

        it("Epoch 10, day 307: More redemption requests are submitted, loss materializes and the junior tranche suffers loss", async function () {});

        it("Epoch 10, day 330: Some redemption requests are fulfilled", async function () {});

        it("Epoch 11, day 333: More redemption requests are submitted, loss materializes and the senior tranche suffers loss", async function () {});

        it("Epoch 11, day 360: Some redemption requests are fulfilled", async function () {});

        it("Epoch 12, day 361: The borrower makes some payment back", async function () {});

        it("Epoch 12, day 365: New lenders injects additional liquidity into both tranches", async function () {});

        it("Epoch 12, day 375: More redemption requests are submitted from old lenders", async function () {});

        it("Epoch 12, day 390: Some redemption requests are fulfilled with some loss recovered", async function () {});

        it("Epoch 13, day 393: The borrower makes full payment", async function () {});

        it("Epoch 13, day 395: More redemption requests are submitted", async function () {});

        it("Epoch 13, day 420: Redemption requests are fulfilled", async function () {});
    });

    describe("With RiskAdjustedTranchesPolicy", function () {
        it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {});

        it("Epoch 0, day 30: 1st payment by the borrower and distribution of profit", async function () {});

        it("Epoch 1, day 35: Lenders in both tranches request redemption", async function () {});

        it("Epoch 1, day 40: Senior lenders put in additional redemption requests", async function () {});

        it("Epoch 1, day 60: 2nd payment by the borrower and the fulfillment of the redemption requests", async function () {
            // All redemption requests are fulfilled.
        });

        it("Epoch 2, day 65: New senior lenders inject liquidity", async function () {});

        it("Epoch 2, day 70: Senior lenders attempts to inject liquidity, but blocked by senior : junior ratio", async function () {});

        it("Epoch 2, day 75: New junior lenders inject liquidity", async function () {});

        it("Epoch 2, day 80: Senior lenders are now able to inject additional liquidity", async function () {});

        it("Epoch 2, day 85: Junior lenders add redemption request", async function () {});

        it("Epoch 2, day 90: No payment from the borrower, hence no fulfillment of the junior redemption requests", async function () {});

        it("Epoch 3, day 95: Late 3rd payment", async function () {});

        it("Epoch 3, day 120: No payment from the borrower, so only partial fulfillment of the junior redemption requests", async function () {});

        it("Epoch 4, day 130: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {});

        it("Epoch 4, day 150: 4th payment and partial fulfillment of junior redemption requests", async function () {
            // The remaining requests are blocked by senior: junior ratio.
        });

        it("Epoch 5, day 170: Senior lenders request redemption", async function () {});

        it("Epoch 5, day 180: 5th payment and complete fulfillment of all redemption requests", async function () {});

        it("Epoch 8, day 270: Default triggered due to late payment", async function () {});

        it("Epoch 9, day 275: Lenders in both tranches submit redemption requests, loss materializes and first loss cover kicks in", async function () {});

        it("Epoch 9, day 300: Redemption requests are fulfilled without loss", async function () {});

        it("Epoch 10, day 307: More redemption requests are submitted, loss materializes and the junior tranche suffers loss", async function () {});

        it("Epoch 10, day 330: Some redemption requests are fulfilled", async function () {});

        it("Epoch 11, day 333: More redemption requests are submitted, loss materializes and the senior tranche suffers loss", async function () {});

        it("Epoch 11, day 360: Some redemption requests are fulfilled", async function () {});

        it("Epoch 12, day 361: The borrower makes some payment back", async function () {});

        it("Epoch 12, day 365: New lenders injects additional liquidity into both tranches", async function () {});

        it("Epoch 12, day 375: More redemption requests are submitted from old lenders", async function () {});

        it("Epoch 12, day 390: Some redemption requests are fulfilled with some loss recovered", async function () {});

        it("Epoch 13, day 393: The borrower makes full payment", async function () {});

        it("Epoch 13, day 395: More redemption requests are submitted", async function () {});

        it("Epoch 13, day 420: Redemption requests are fulfilled", async function () {});
    });
});

describe("For pools with flex-loan enabled", function () {
    describe("With FixedYieldTranchesPolicy", function () {
        before(async function () {
            // Set flex-call window to 1 for ease of testing.
        });

        it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {});

        it("Epoch 0, day 30: 1st payment by the borrower and profit distribution", async function () {});

        it("Epoch 1, day 35: Lenders in both tranches request redemption", async function () {});

        it("Epoch 1, day 60: 2nd payment by the borrower and complete fulfillment of immature redemption requests", async function () {
            // Since there's fund in the pool, redemption requests are fulfilled even though they are immature.
        });

        it("Epoch 2, day 65: Senior lenders submit redemption requests", async function () {});

        it("Epoch 2, day 83: Junior lenders submit redemption requests", async function () {});

        it("Epoch 2, day 90: 3rd payment from the borrower. Partial fulfillment of immature redemption requests", async function () {});

        it("Epoch 3, day 100: Senior lenders submit redemption requests", async function () {});

        it("Epoch 3, day 120: No payment from the borrower, no redemption request fulfilled", async function () {});

        it("Epoch 4, day 126: Late 4th payment from the borrower", async function () {});

        it("Epoch 4, Day 150: Partial fulfillment of mature redemption requests", async function () {
            // The remaining requests are blocked by senior: junior ratio.
        });

        it("Epoch 5, day 180: 5th payment and complete fulfillment of all redemption requests", async function () {});

        it("Epoch 6, day 186: Lenders from both tranches submit redemption requests", async function () {});

        it("Epoch 6, day 210: No payment from the borrower, no redemption request fulfilled", async function () {});

        it("Epoch 7, day 220: Senior lenders submit more redemption requests", async function () {});

        it("Epoch 7, day 240: 6th payment from the borrower, complete fulfillment of redemption requests", async function () {
            // Test the following scenario:
            // Mature senior redemption requests are completely fulfilled.
            // Junior redemption requests are partially fulfilled, initially blocked by the senior : junior ratio.
            // Immature redemption requests are fulfilled.
            // All junior redemption requests are fulfilled due to the fulfillment of immature senior redemption requests
            // making the senior : junior ratio not a blocker anymore.
        });

        it("Epoch 10, day 330: Default triggered", async function () {});

        it("Epoch 11, day 331: Lenders from both tranches submit redemption requests, loss materializes and first loss cover kicks in", async function () {});

        it("Epoch 11, day 360: No payment from the borrower, some redemption requests fulfilled", async function () {});

        it("Epoch 12, day 373: More redemption requests are submitted, more loss materializes and the junior tranche suffers loss", async function () {});

        it("Epoch 12, day 390: No payment from the borrower, some redemption requests fulfilled", async function () {});

        it("Epoch 13, day 400: More redemption requests are submitted, more loss materializes and the senior tranche suffers loss", async function () {});

        it("Epoch 13, day 405: The borrower makes some payment back", async function () {});

        it("Epoch 13, day 420: Some redemption requests fulfilled", async function () {});

        it("Epoch 14, day 435: The borrower makes full payment", async function () {});

        it("Epoch 14, day 450: Redemption requests are fulfilled", async function () {});
    });

    describe("With RiskAdjustedTranchesPolicy", function () {
        before(async function () {
            // Set flex-call window to 1 for ease of testing.
        });

        it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {});

        it("Epoch 0, day 30: 1st payment by the borrower and profit distribution", async function () {});

        it("Epoch 1, day 35: Lenders in both tranches request redemption", async function () {});

        it("Epoch 1, day 60: 2nd payment by the borrower and complete fulfillment of immature redemption requests", async function () {
            // Since there's fund in the pool, redemption requests are fulfilled even though they are immature.
        });

        it("Epoch 2, day 65: Senior lenders submit redemption requests", async function () {});

        it("Epoch 2, day 83: Junior lenders submit redemption requests", async function () {});

        it("Epoch 2, day 90: 3rd payment from the borrower. Partial fulfillment of immature redemption requests", async function () {});

        it("Epoch 3, day 100: Senior lenders submit redemption requests", async function () {});

        it("Epoch 3, day 120: No payment from the borrower, no redemption request fulfilled", async function () {});

        it("Epoch 4, day 126: Late 4th payment from the borrower", async function () {});

        it("Epoch 4, Day 150: Partial fulfillment of mature redemption requests", async function () {
            // The remaining requests are blocked by senior: junior ratio.
        });

        it("Epoch 5, day 180: 5th payment and complete fulfillment of all redemption requests", async function () {});

        it("Epoch 6, day 186: Lenders from both tranches submit redemption requests", async function () {});

        it("Epoch 6, day 210: No payment from the borrower, no redemption request fulfilled", async function () {});

        it("Epoch 7, day 220: Senior lenders submit more redemption requests", async function () {});

        it("Epoch 7, day 240: 6th payment from the borrower, complete fulfillment of redemption requests", async function () {
            // Test the following scenario:
            // Mature senior redemption requests are completely fulfilled.
            // Junior redemption requests are partially fulfilled, initially blocked by the senior : junior ratio.
            // Immature redemption requests are fulfilled.
            // All junior redemption requests are fulfilled due to the fulfillment of immature senior redemption requests
            // making the senior : junior ratio not a blocker anymore.
        });

        it("Epoch 10, day 330: Default triggered", async function () {});

        it("Epoch 11, day 331: Lenders from both tranches submit redemption requests, loss materializes and first loss cover kicks in", async function () {});

        it("Epoch 11, day 360: No payment from the borrower, some redemption requests fulfilled", async function () {});

        it("Epoch 12, day 373: More redemption requests are submitted, more loss materializes and the junior tranche suffers loss", async function () {});

        it("Epoch 12, day 390: No payment from the borrower, some redemption requests fulfilled", async function () {});

        it("Epoch 13, day 400: More redemption requests are submitted, more loss materializes and the senior tranche suffers loss", async function () {});

        it("Epoch 13, day 405: The borrower makes some payment back", async function () {});

        it("Epoch 13, day 420: Some redemption requests fulfilled", async function () {});

        it("Epoch 13, day 430: New lenders inject additional liquidity into both tranches", async function () {});

        it("Epoch 14, day 435: The borrower makes full payment", async function () {});

        it("Epoch 14, day 450: Redemption requests are fulfilled", async function () {});
    });
});
