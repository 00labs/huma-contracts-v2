// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {ReceivableInput} from "../CreditStructs.sol";
import {CreditConfig, CreditLimit} from "../CreditStructs.sol";

interface IReceivableLevelCreditManager {
    /**
     * @notice Approves the credit with the terms provided.
     * @param borrower the borrower address
     * @param receivableInput the receivable input contains
     *   receivableAmount - the underlying token amount represents the value of the receivable
     *   receivableId     - the NFT token id of the receivable
     * @param creditLimit the credit limit of the credit line
     * @param remainingPeriods the number of periods before the credit line expires
     * @param yieldInBps expected yield expressed in basis points, 1% is 100, 100% is 10000
     * @dev only Evaluation Agent can call
     */
    function approveReceivable(
        address borrower,
        ReceivableInput memory receivableInput,
        uint96 creditLimit,
        uint16 remainingPeriods,
        uint16 yieldInBps
    ) external;

    /**
     * @notice Updates the account and brings its billing status current
     * @dev If the account is defaulted, no need to update the account anymore.
     */
    function refreshCredit(uint256 receivableId) external;

    /**
     * @notice Triggers the default process
     * @return principalLoss the amount of principal loss
     * @return yieldLoss the amount of yield loss
     * @return feesLoss the amount of fees loss
     * @dev It is possible for the borrower to payback even after default, especially in
     * receivable factoring cases.
     */
    function triggerDefault(
        uint256 receivableId
    ) external returns (uint256 principalLoss, uint256 yieldLoss, uint256 feesLoss);

    /**
     * @notice Closes a credit record.
     * @dev Only borrower or EA Service account can call this function
     * @dev Revert if there is still balance due
     * @dev Revert if the committed amount is non-zero and there are periods remaining
     */
    function closeCredit(uint256 receivableId) external;

    /**
     * @notice Pauses the credit. No drawdown is allowed for paused credit.
     * @dev Only EA can call this function
     */
    function pauseCredit(uint256 receivableId) external;

    /**
     * @notice Unpauses the credit to return the credit to normal
     * @dev Only EA can call this function
     */
    function unpauseCredit(uint256 receivableId) external;

    /**
     * @notice Updates the yield for the credit.
     * @param yieldInBps the new yield
     * @dev Only EA can call this function
     */
    function updateYield(uint256 receivableId, uint256 yieldInBps) external;

    /**
     * @notice Updates the limit and commitment amount for this credit
     * @param creditLimit the credit limit
     * @param committedAmount the committed amount. The borrower will be charged interest for
     * this amount even if the daily average borrowing amount in a month is less than this amount.
     * @dev Only EA can call this function
     */
    function updateLimitAndCommitment(
        uint256 receivableId,
        uint256 creditLimit,
        uint256 committedAmount
    ) external;

    /**
     * @notice Updates the remaining periods of the credit line
     * @param numOfPeriods the new remaining periods
     * @dev Only EA can call this function
     */
    function extendRemainingPeriod(uint256 receivableId, uint256 numOfPeriods) external;

    /**
     * @notice Waive late fee
     */
    function waiveLateFee(uint256 receivableId, uint256 waivedAmount) external;

    function onlyPayer(address account, bytes32 creditHash) external view returns (address);

    function getReceivableCreditConfig(
        uint256 receivableId
    ) external view returns (CreditConfig memory);
}
