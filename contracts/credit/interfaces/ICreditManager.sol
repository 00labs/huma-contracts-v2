// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {CreditConfig} from "../CreditStructs.sol";

interface ICreditManager {
    /**
     * @notice Checks whether the borrower is the owner of the credit associated with the creditHash.
     * @param creditHash The hash of the credit.
     * @param borrower The address of the borrower.
     */
    function onlyCreditBorrower(bytes32 creditHash, address borrower) external view;

    /**
     * @notice Returns the CreditConfig associated with the creditHash.
     * @param creditHash The hash of the credit.
     * @return The CreditConfig associated with the creditHash.
     */
    function getCreditConfig(bytes32 creditHash) external view returns (CreditConfig memory);

    /**
     * @notice Returns the borrower of the credit associated with the creditHash.
     * @param creditHash The hash of the credit.
     * @param borrower The borrower of the credit associated with the creditHash.
     */
    function getCreditBorrower(bytes32 creditHash) external view returns (address borrower);
}
