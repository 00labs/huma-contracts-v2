// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IBorrowerLevelCreditConfig} from "./interfaces/IBorrowerLevelCreditConfig.sol";
import {Credit} from "./Credit.sol";
import {CreditConfig, CreditRecord} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

import "hardhat/console.sol";

//* Reserved for Richard review, to be deleted, please review this contract

/**
 * Credit is the basic borrowing entry in Huma Protocol.
 * BaseCredit is the base form of a Credit.
 * The key functions include: approve, drawdown, makePayment, refreshProfitAndLoss
 * Supporting functions include: updateCreditLine, closeCreditLine,
 *
 * Key design considerations:
 * 1) Refresh profit and loss by using an IProfitLossRefersher
 * 2) separate lastUpdateDate for profit and loss
 * 3) Mostly Credit-level limit, also supports borrower-level limit
 */
contract BorrowerLevelCreditConfig is Credit, IBorrowerLevelCreditConfig {
    /**
     * @notice Updates the account and brings its billing status current
     * @dev If the account is defaulted, no need to update the account anymore.
     * @dev If the account is ready to be defaulted but not yet, update the account without
     * distributing the income for the upcoming period. Otherwise, update and distribute income
     * note the reason that we do not distribute income for the final cycle anymore since
     * it does not make sense to distribute income that we know cannot be collected to the
     * administrators (e.g. protocol, pool owner and EA) since it will only add more losses
     * to the LPs. Unfortunately, this special business consideration added more complexity
     * and cognitive load to _updateDueInfo(...).
     */
    function refreshCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _refreshCredit(creditHash);
    }

    /**
     * @notice Triggers the default process
     * @return losses the amount of remaining losses to the pool
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function triggerDefault(address borrower) external virtual override returns (uint256 losses) {
        bytes32 creditHash = getCreditHash(borrower);
        _triggerDefault(creditHash);
    }

    /**
     * @notice Closes a credit record.
     * @dev Only borrower or EA Service account can call this function
     * @dev Revert if there is still balance due
     * @dev Revert if the committed amount is non-zero and there are periods remaining
     */
    function closeCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _closeCredit(creditHash);
    }

    function pauseCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _pauseCredit(creditHash);
    }

    function unpauseCredit(address borrower) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _unpauseCredit(creditHash);
    }

    function updateYield(address borrower, uint256 yieldInBps) external virtual override {
        bytes32 creditHash = getCreditHash(borrower);
        _updateYield(creditHash, yieldInBps);
    }

    function getCreditHash(address borrower) internal view virtual returns (bytes32 creditHash) {
        return keccak256(abi.encode(address(this), borrower));
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function updateRemainingPeriods(
        address borrower,
        uint256 numOfPeriods
    ) external virtual override {
        _onlyEAServiceAccount();
        bytes32 creditHash = getCreditHash(borrower);
        _updateRemainingPeriods(creditHash, numOfPeriods);
    }

    /// @inheritdoc IBorrowerLevelCreditConfig
    function updateLimitAndCommitment(
        address borrower,
        uint256 creditLimit,
        uint256 committedAmount
    ) external virtual override {
        _onlyEAServiceAccount();
        bytes32 creditHash = getCreditHash(borrower);
        CreditConfig memory cc = _getCreditConfig(creditHash);
        cc.creditLimit = uint96(creditLimit);
        cc.committedAmount = uint96(committedAmount);
        _setCreditConfig(creditHash, cc);
    }
}
